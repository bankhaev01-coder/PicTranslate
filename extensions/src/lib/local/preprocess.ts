/**
 * Чистые пиксельные хелперы для OCR-предобработки (без DOM — юнит-тестируемые).
 * Порт backend-функции `_preprocess` (оттенки серого) на RGBA-данные in place +
 * нормализация контраста, адаптивная бинаризация Оцу и апскейл для мелкого текста.
 */
export function grayscaleInPlace(rgba: Uint8ClampedArray): void {
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    // Luma по ITU-R BT.601 — те же коэффициенты, что в Python-бэкенде (PIL 'L').
    const l = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) | 0;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = l;
  }
}

/**
 * Линейная растяжка контраста (min-max normalization) in place.
 * Находит min и max яркости и растягивает диапазон до [0, 255].
 * Если картинка однородная (min === max), оставляет без изменений.
 */
export function normalizeContrastInPlace(rgba: Uint8ClampedArray): void {
  let min = 255;
  let max = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const v = rgba[i]; // предполагается grayscale, R=G=B
    if (v < min) min = v;
    if (v > max) max = v;
  }

  if (min >= max) return; // полностью плоский цвет

  const range = max - min;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const norm = Math.round(((rgba[i] - min) * 255) / range);
    rgba[i] = rgba[i + 1] = rgba[i + 2] = norm;
  }
}

/**
 * Бинаризация методом Оцу (Otsu's thresholding) in place.
 * Вычисляет оптимальный глобальный порог по гистограмме полутонов
 * для разделения фона и текста (0 или 255). Альфа-канал не затрагивается.
 */
export function binarizeOtsuInPlace(rgba: Uint8ClampedArray): void {
  const hist = new Int32Array(256);
  let totalPixels = 0;

  for (let i = 0; i + 3 < rgba.length; i += 4) {
    hist[rgba[i]]++;
    totalPixels++;
  }

  if (totalPixels === 0) return;

  let sum = 0;
  for (let t = 0; t < 256; t++) {
    sum += t * hist[t];
  }

  let sumB = 0;
  let wB = 0;
  let maxVariance = 0;
  let threshold = 128;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = totalPixels - wB;
    if (wF === 0) break;

    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;

    const varianceBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varianceBetween > maxVariance) {
      maxVariance = varianceBetween;
      threshold = t;
    }
  }

  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const val = rgba[i] > threshold ? 255 : 0;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = val;
  }
}

/**
 * Коэффициент увеличения canvas, чтобы меньшая сторона дошла до minDimension
 * (Tesseract хочет 30-40px на строку). 1 — увеличение не нужно; максимум ×4 —
 * иначе время OCR растёт неограниченно. Чистая функция — юнит-тестируется.
 */
export function computeUpscaleFactor(width: number, height: number, minDimension: number): number {
  if (width <= 0 || height <= 0) return 1;
  const minSide = Math.min(width, height);
  if (minSide >= minDimension) return 1;
  return Math.min(4, Math.max(1.5, Math.ceil(minDimension / minSide)));
}

/**
 * Белая рамка вокруг кропа перед OCR: LSTM точнее читает текст, не упирающийся
 * в край кадра (при выделении рамкой так почти всегда). 3% меньшей стороны,
 * в пределах [8, 24] px; 0 — рамка не нужна (нулевой размер). Чистая функция.
 */
export function computePad(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 0;
  return Math.max(8, Math.min(24, Math.round(Math.min(width, height) * 0.03)));
}

/**
 * Увеличение разрешения canvas, если его высота или ширина меньше minSize (по умолчанию 300px),
 * чтобы Tesseract OCR получил достаточный DPI/размер символов (не менее 30-40px на строку).
 */
export function upscaleToMinTextHeight(
  sourceCanvas: HTMLCanvasElement,
  minDimension = 300,
): HTMLCanvasElement {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const factor = computeUpscaleFactor(w, h, minDimension);
  if (factor <= 1) return sourceCanvas;

  const scaledCanvas = document.createElement('canvas');
  scaledCanvas.width = Math.round(w * factor);
  scaledCanvas.height = Math.round(h * factor);

  const ctx = scaledCanvas.getContext('2d');
  if (!ctx) return sourceCanvas;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, scaledCanvas.width, scaledCanvas.height);
  return scaledCanvas;
}

/**
 * Инверсия яркости in place — для страниц с белым текстом на чёрном фоне
 * (тёмные темы, светлые реплики на тёмных пузырях). Альфа-канал не затрагивается.
 */
export function invertInPlace(rgba: Uint8ClampedArray): void {
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    rgba[i] = 255 - rgba[i];
    rgba[i + 1] = 255 - rgba[i + 1];
    rgba[i + 2] = 255 - rgba[i + 2];
  }
}

/**
 * Unsharp mask (3×3 box blur) in place: усиливает края букв после апскейла
 * мыльного мелкого текста — Tesseract реже склеивает «rn» в «m» и т.п.
 * Предполагается grayscale; альфа-канал не затрагивается.
 */
export function sharpenInPlace(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  strength = 0.7,
): void {
  if (width <= 0 || height <= 0) return;
  const src = new Float32Array(width * height);
  for (let i = 0, p = 0; i < src.length; i++, p += 4) src[i] = rgba[p];

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      let sum = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx++) sum += src[row + xx];
      }
      const blurred = sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
      const v = src[y * width + x];
      const sharp = Math.round(v + strength * (v - blurred));
      const clamped = sharp < 0 ? 0 : sharp > 255 ? 255 : sharp;
      const p = (y * width + x) * 4;
      rgba[p] = rgba[p + 1] = rgba[p + 2] = clamped;
    }
  }
}

/**
 * Адаптивная бинаризация Сауволы (Sauvola) in place: порог считается локально
 * по окну ±windowRadius через интегральные изображения (O(n) на картинку),
 * поэтому неравномерный фон (градиент, блики, JPEG-артефакты) не съедает
 * мелкий текст — в отличие от глобального порога Оцу.
 *
 * threshold = m * (1 + k * (s / R - 1)), где m и s — локальное среднее и
 * отклонение, R = 128 (динамический диапазон яркости).
 * Предполагается grayscale (R=G=B), как после grayscaleInPlace.
 */
export function binarizeSauvolaInPlace(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  windowRadius = 15,
  k = 0.2,
): void {
  if (width <= 0 || height <= 0) return;
  const w1 = width + 1;
  const n1 = w1 * (height + 1);

  // Интегральные изображения (1-индексированные) для суммы и суммы квадратов.
  const sum = new Float64Array(n1);
  const sq = new Float64Array(n1);
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    let rowSq = 0;
    const srcBase = y * width * 4;
    for (let x = 0; x < width; x++) {
      const v = rgba[srcBase + x * 4];
      rowSum += v;
      rowSq += v * v;
      const i = (y + 1) * w1 + (x + 1);
      sum[i] = sum[y * w1 + (x + 1)] + rowSum;
      sq[i] = sq[y * w1 + (x + 1)] + rowSq;
    }
  }

  const rectSum = (table: Float64Array, x0: number, y0: number, x1: number, y1: number) =>
    table[y1 * w1 + x1] - table[y0 * w1 + x1] - table[y1 * w1 + x0] + table[y0 * w1 + x0];

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - windowRadius);
    const y1 = Math.min(height, y + windowRadius + 1);
    const base = y * width * 4;
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - windowRadius);
      const x1 = Math.min(width, x + windowRadius + 1);
      const count = (x1 - x0) * (y1 - y0);
      const s = rectSum(sum, x0, y0, x1, y1);
      const q = rectSum(sq, x0, y0, x1, y1);
      const mean = s / count;
      const variance = Math.max(0, q / count - mean * mean);
      const stdDev = Math.sqrt(variance);
      const threshold = mean * (1 + k * (stdDev / 128 - 1));
      const val = rgba[base + x * 4] > threshold ? 255 : 0;
      rgba[base + x * 4] = rgba[base + x * 4 + 1] = rgba[base + x * 4 + 2] = val;
    }
  }
}
