import { createWorker, OEM, PSM } from 'tesseract.js';
import type { VendorManifest } from './registry';
import type { Box, OcrQuality } from '../types';
import {
  binarizeOtsuInPlace,
  binarizeSauvolaInPlace,
  invertInPlace,
  normalizeContrastInPlace,
} from './preprocess';

type TesseractWorker = Awaited<ReturnType<typeof createWorker>>;

export interface OcrResult {
  text: string;
  boxes: Box[];
  confidence: number;
}

export interface RecognizeBestOptions {
  /** Сколько вариантов предобработки пробовать (fast/balanced/best). */
  quality?: OcrQuality;
  /** Порог уверенности для включения блоков в результат. */
  minConfidence?: number;
  /** Кроп области: берём SINGLE_BLOCK вместо SPARSE_TEXT (текст заполняет кадр). */
  regionOnly?: boolean;
}

/** Вариант предобработки одного прохода OCR. */
export type OcrVariant = 'otsu' | 'contrast' | 'otsu-invert' | 'sauvola';

/** План проходов по качеству: 1 / 2 / 4 варианта (побеждает лучший балл). */
const QUALITY_VARIANTS: Record<OcrQuality, readonly OcrVariant[]> = {
  fast: ['otsu'],
  balanced: ['otsu', 'contrast'],
  best: ['otsu', 'contrast', 'otsu-invert', 'sauvola'],
};

/** Ранний выход: уверенность ≥ порога и непустой текст — остальные проходы не нужны. */
const EARLY_EXIT_CONFIDENCE = 90;

/**
 * Балл результата OCR: уверенность × ln(1 + длина текста). Маленький мусор
 * при высокой уверенности проигрывает осмысленному тексту; пустой текст = 0.
 * Чистая функция — юнит-тестируется.
 */
export function scoreOcrResult(res: Pick<OcrResult, 'text' | 'confidence'>): number {
  const len = res.text.trim().length;
  if (!len) return 0;
  return res.confidence * Math.log1p(len);
}

/** Выбрать лучший из нескольких проходов OCR. Пустой список → пустой результат. */
export function pickBestOcr(candidates: readonly OcrResult[]): OcrResult {
  let best: OcrResult = { text: '', boxes: [], confidence: 0 };
  let bestScore = -1;
  for (const cand of candidates) {
    const score = scoreOcrResult(cand);
    if (score > bestScore) {
      best = cand;
      bestScore = score;
    }
  }
  return best;
}

let worker: TesseractWorker | null = null;
let langsKey = '';
/** Индекс рабочей сборки core (0 — самая быстрая). После fallback назад не возвращаемся. */
let coreIdx = 0;
/** Индекс сборки, на которой создан текущий worker (-1 — нет worker). */
let workerCoreIdx = -1;

/**
 * Сборки tesseract-core от быстрой к базовой.
 * relaxedSIMD падает на части CPU/браузеров с
 * `Aborted(missing function: …DotProductSSE…)` — тогда спускаемся ниже.
 */
const CORE_FILES = [
  'tesseract-core-relaxedsimd-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-lstm.wasm.js',
] as const;

const CORE_SHORT = ['relaxedsimd-lstm', 'simd-lstm', 'lstm'] as const;

/** Ошибка SIMD-несоответствия сборки и CPU/браузера — имеет смысл пробовать базовую. */
function isSimdAbort(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  return /missing function|Aborted|DotProduct|wasm/i.test(msg);
}

/**
 * Лениво создать (и пересоздать при смене языков) tesseract-worker.
 *
 * Полностью офлайновый режим: все необходимые worker/core/traineddata должны
 * входить в vendor-пак расширения. Отсутствующие файлы дают явную ошибку
 * вместо молчаливого отката на CDN.
 */
export async function ensureOcr(langs: string[], vendor: VendorManifest | null): Promise<TesseractWorker> {
  const key = [...langs].sort().join('+') || 'eng';
  if (worker && langsKey === key && workerCoreIdx === coreIdx) return worker;
  await dropWorker();

  const options: Record<string, unknown> = {
    cacheMethod: 'write', // чтение+запись кеша traineddata в IndexedDB
    gzip: true,
  };

  if (!vendor?.tesseract || !vendor.baseUrl) {
    throw new Error('offline OCR asset pack is missing');
  }
  // Полностью офлайн: worker + сборки core + traineddata отдаются из расширения.
  options.workerBlobURL = false;
  options.workerPath = new URL('tesseract/worker.min.js', vendor.baseUrl).href;
  options.corePath = new URL('tesseract/tesseract-core-relaxedsimd-lstm.wasm.js', vendor.baseUrl).href;
  options.langPath = new URL('tessdata/', vendor.baseUrl).href.replace(/\/+$/, '');

  // Fallback-цепочка сборок: relaxedSIMD → SIMD → baseline.
  // На части CPU/браузеров SIMD-сборка падает при загрузке с
  // `Aborted(missing function: …DotProductSSE…)` — спускаемся на базовую.
  let lastError: unknown = null;
  for (; coreIdx < CORE_FILES.length; coreIdx++) {
    options.corePath = new URL(`tesseract/${CORE_FILES[coreIdx]}`, vendor.baseUrl).href;
    try {
      worker = await createWorker(key.split('+'), OEM.LSTM_ONLY, options);
      langsKey = key;
      workerCoreIdx = coreIdx;
      // Оптимизация параметров распознавания для комиксов и разреженного текста
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        user_defined_dpi: '300',
        preserve_interword_spaces: '1',
      });
      if (coreIdx > 0) {
        console.warn(`[translate-ext] tesseract core fallback: using ${CORE_SHORT[coreIdx]}`);
      }
      return worker;
    } catch (e) {
      lastError = e;
      await dropWorker();
      // Не-SIMD ошибка (нет ассетов, битый пак) — ниже по цепочке не поможет.
      if (!isSimdAbort(e)) break;
    }
  }
  throw new Error(
    `OCR [${CORE_SHORT[Math.min(coreIdx, CORE_SHORT.length - 1)]}]: ${String((lastError as Error)?.message ?? lastError)}`,
  );
}

async function dropWorker(): Promise<void> {
  if (worker) {
    try {
      await worker.terminate();
    } catch {
      /* не страшно */
    }
    worker = null;
  }
  workerCoreIdx = -1;
}

/** Тестовый шов: сбросить состояние fallback-цепочки. */
export function _resetOcrState(): void {
  worker = null;
  langsKey = '';
  coreIdx = 0;
  workerCoreIdx = -1;
}

/** Запустить OCR на canvas/dataURL и вернуть структурированный результат (текст, боксы, confidence). */
export async function recognizeText(
  image: HTMLCanvasElement | string,
  langs: string[],
  vendor: VendorManifest | null,
  minConfidence = 40,
  psm: PSM = PSM.SPARSE_TEXT,
): Promise<OcrResult> {
  // Крах SIMD-сборки может вылететь и на фазе recognize (LSTM-ядра), а не
  // только при загрузке — тогда спускаемся на следующую сборку и повторяем.
  for (;;) {
    const w = await ensureOcr(langs, vendor);
    const usedIdx = workerCoreIdx;
    try {
      // PSM задаётся на каждый проход: regionOnly (кроп) требует SINGLE_BLOCK.
      await w.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await w.recognize(image as never, {}, { blocks: true });
      const overallConfidence = data?.confidence ?? 0;
      const text = (data?.text ?? '').trim();
      const boxes: Box[] = [];

      // Извлекаем блоки/параграфы/строки с достаточной уверенностью
      if (data?.blocks?.length) {
        for (const block of data.blocks) {
          const blockText = (block.text ?? '').trim();
          if (!blockText) continue;
          if (block.confidence < minConfidence) continue;

          // Если у блока есть paragraphs/lines, можно разбить на строки для более точных пузырей,
          // либо взять сам блок, если он достаточно компактен. Возьмем параграфы/строки:
          if (block.paragraphs?.length) {
            for (const para of block.paragraphs) {
              const paraText = (para.text ?? '').trim();
              if (!paraText || para.confidence < minConfidence) continue;
              const bbox = para.bbox;
              boxes.push({
                x: bbox.x0,
                y: bbox.y0,
                width: bbox.x1 - bbox.x0,
                height: bbox.y1 - bbox.y0,
                text: paraText,
              });
            }
          } else {
            const bbox = block.bbox;
            boxes.push({
              x: bbox.x0,
              y: bbox.y0,
              width: bbox.x1 - bbox.x0,
              height: bbox.y1 - bbox.y0,
              text: blockText,
            });
          }
        }
      }

      return {
        text,
        boxes,
        confidence: overallConfidence,
      };
    } catch (e) {
      if (!isSimdAbort(e) || usedIdx + 1 >= CORE_FILES.length) {
        throw new Error(`OCR [${CORE_SHORT[Math.max(0, usedIdx)]}]: ${String((e as Error)?.message ?? e)}`);
      }
      console.warn(
        `[translate-ext] tesseract core fallback at recognize: ${CORE_SHORT[usedIdx]} → ${CORE_SHORT[usedIdx + 1]}`,
      );
      coreIdx = usedIdx + 1;
      await dropWorker();
    }
  }
}

/** Клонировать canvas (все варианты предобработки работают на своих копиях). */
function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = src.width;
  canvas.height = src.height;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.drawImage(src, 0, 0);
  return canvas;
}

/** Применить один вариант предобработки к canvas (grayscale уже применён снаружи). */
function applyVariant(canvas: HTMLCanvasElement, variant: OcrVariant): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imageData.data;
  normalizeContrastInPlace(d);
  switch (variant) {
    case 'otsu':
      binarizeOtsuInPlace(d);
      break;
    case 'contrast':
      break; // только растяжка контраста — полутоновые страницы и антиалиасинг
    case 'otsu-invert':
      binarizeOtsuInPlace(d);
      invertInPlace(d);
      break;
    case 'sauvola':
      binarizeSauvolaInPlace(d, canvas.width, canvas.height);
      break;
  }
  ctx.putImageData(imageData, 0, 0);
}

/**
 * Многопроходный OCR: для каждого варианта предобработки из плана качества
 * (fast/balanced/best) строится копия canvas и запускается распознавание;
 * побеждает лучший балл `confidence × ln(1 + длина)`. При уверенности ≥ 90
 * с непустым текстом — ранний выход, остальные проходы не выполняются.
 *
 * `regionOnly` (кроп области) использует PSM.SINGLE_BLOCK вместо SPARSE_TEXT.
 */
export async function recognizeBest(
  image: HTMLCanvasElement,
  langs: string[],
  vendor: VendorManifest | null,
  options: RecognizeBestOptions = {},
): Promise<OcrResult> {
  const { quality = 'balanced', minConfidence = 40, regionOnly = false } = options;
  const psm = regionOnly ? PSM.SINGLE_BLOCK : PSM.SPARSE_TEXT;
  const variants = QUALITY_VARIANTS[quality];

  const results: OcrResult[] = [];
  for (const variant of variants) {
    const canvas = cloneCanvas(image);
    applyVariant(canvas, variant);
    const res = await recognizeText(canvas, langs, vendor, minConfidence, psm);
    results.push(res);
    if (res.text.trim() && res.confidence >= EARLY_EXIT_CONFIDENCE) break;
  }
  return pickBestOcr(results);
}
