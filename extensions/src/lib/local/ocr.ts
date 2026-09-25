import { createWorker, OEM } from 'tesseract.js';
import type { VendorManifest } from './registry';

type TesseractWorker = Awaited<ReturnType<typeof createWorker>>;

let worker: TesseractWorker | null = null;
let langsKey = '';

/**
 * Лениво создать (и пересоздать при смене языков) tesseract-worker.
 *
 * Полностью офлайновый режим: все необходимые worker/core/traineddata должны
 * входить в vendor-пак расширения. Отсутствующие файлы дают явную ошибку
 * вместо молчаливого отката на CDN.
 */
export async function ensureOcr(langs: string[], vendor: VendorManifest | null): Promise<TesseractWorker> {
  const key = [...langs].sort().join('+') || 'eng';
  if (worker && langsKey === key) return worker;
  if (worker) {
    try {
      await worker.terminate();
    } catch {
      /* не страшно */
    }
    worker = null;
  }

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
  options.corePath = new URL('tesseract/', vendor.baseUrl).href; // каталог со ВСЕМИ сборками
  options.langPath = new URL('tessdata/', vendor.baseUrl).href.replace(/\/+$/, '');

  worker = await createWorker(key.split('+'), OEM.LSTM_ONLY, options);
  langsKey = key;
  return worker;
}

/** Запустить OCR на canvas/dataURL и вернуть простой текст. */
export async function recognizeText(
  image: HTMLCanvasElement | string,
  langs: string[],
  vendor: VendorManifest | null,
): Promise<string> {
  const w = await ensureOcr(langs, vendor);
  const { data } = await w.recognize(image as never);
  return (data?.text ?? '').trim();
}
