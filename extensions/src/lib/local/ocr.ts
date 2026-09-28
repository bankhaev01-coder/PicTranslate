import { createWorker, OEM, PSM } from 'tesseract.js';
import type { VendorManifest } from './registry';
import type { Box, OcrQuality } from '../types';
import {
  binarizeOtsuInPlace,
  binarizeSauvolaInPlace,
  invertInPlace,
  normalizeContrastInPlace,
  sharpenInPlace,
} from './preprocess';
import { joinOcrLines } from './text';

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
export type OcrVariant = 'otsu' | 'contrast' | 'otsu-invert' | 'sauvola' | 'sharpen';

/** План проходов по качеству: до 1 / 3 / 5 вариантов (побеждает лучший балл). */
const QUALITY_VARIANTS: Record<OcrQuality, readonly OcrVariant[]> = {
  fast: ['otsu'],
  balanced: ['otsu', 'contrast', 'sharpen'],
  best: ['otsu', 'contrast', 'sharpen', 'otsu-invert', 'sauvola'],
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

/** Структурный срез данных tesseract, нужный для сборки текста и боксов. */
export interface OcrDataSlice {
  text?: string;
  confidence?: number;
  blocks?: Array<{
    text?: string;
    confidence?: number;
    bbox?: { x0: number; y0: number; x1: number; y1: number };
    paragraphs?: Array<{
      text?: string;
      confidence?: number;
      bbox?: { x0: number; y0: number; x1: number; y1: number };
    }>;
  }>;
}

/**
 * Собрать результат OCR из данных tesseract: тексты всех уровней проходят
 * через `joinOcrLines`, поэтому многострочный пузырь уходит в MT единой
 * фразой, а не набором строк («весь текст един»).
 *
 * `singleLine` (кроп выделенной области) — весь текст кадра в одну строку.
 * Полный скан — каждый блок остаётся отдельной строкой (границы пузырей
 * важны для перевода по боксам), внутри блока — тоже одна строка.
 * Чистая функция — юнит-тестируется.
 */
export function assembleOcrResult(
  data: OcrDataSlice | null | undefined,
  minConfidence: number,
  singleLine: boolean,
): OcrResult {
  const confidence = data?.confidence ?? 0;
  const boxes: Box[] = [];
  const blockLines: string[] = [];

  for (const block of data?.blocks ?? []) {
    const blockText = joinOcrLines(block.text ?? '');
    if (!blockText || (block.confidence ?? 0) < minConfidence) continue;
    blockLines.push(blockText);

    if (block.paragraphs?.length) {
      for (const para of block.paragraphs) {
        const paraText = joinOcrLines(para.text ?? '');
        if (!paraText || (para.confidence ?? 0) < minConfidence) continue;
        const bbox = para.bbox;
        if (!bbox) continue;
        boxes.push({
          x: bbox.x0,
          y: bbox.y0,
          width: bbox.x1 - bbox.x0,
          height: bbox.y1 - bbox.y0,
          text: paraText,
        });
      }
    } else if (block.bbox) {
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

  // Общий текст: область — одна строка; полный скан — блоки отдельными
  // строками, если они есть (иначе — как пришло от tesseract).
  const joined = joinOcrLines(data?.text ?? '');
  const text = singleLine
    ? joined || blockLines.join('\n')
    : blockLines.length
      ? blockLines.join('\n')
      : joined;

  return { text, boxes, confidence };
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
      // regionOnly (PSM.SINGLE_BLOCK) — кроп области: весь текст кадра в одну
      // строку. Полный скан — каждый блок остаётся отдельной строкой, внутри
      // блока — тоже одна строка (см. assembleOcrResult).
      return assembleOcrResult(
        data as unknown as OcrDataSlice,
        minConfidence,
        psm === PSM.SINGLE_BLOCK,
      );
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
    case 'sharpen':
      // Резкость без бинаризации: мыльный мелкий текст после апскейла.
      sharpenInPlace(d, canvas.width, canvas.height);
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
