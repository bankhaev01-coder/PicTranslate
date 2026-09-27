import type { PageImage, Point, SelectionRegion } from './types';
import { regionToViewport } from './selection';

/**
 * Собрать «интересные» <img> на странице.
 *
 * Отсекает мелкие картинки (иконки/аватары) и скрытые, чтобы очередь не
 * забивала бэкенд. Возвращает только метаданные — байты грузятся позже, чтобы
 * параллелить загрузку и обрабатывать CORS-ошибки по каждому изображению.
 */
export function scanImages(minSize: number): PageImage[] {
  const out: PageImage[] = [];
  const imgs = Array.from(document.querySelectorAll('img'));
  let index = 0;

  for (const img of imgs) {
    const rect = img.getBoundingClientRect();
    const w = img.naturalWidth || rect.width;
    const h = img.naturalHeight || rect.height;

    // пропускаем иконки/аватары и невидимые изображения
    if (w < minSize || h < minSize) continue;
    if (rect.width === 0 || rect.height === 0) continue;

    const src = img.currentSrc || img.src;
    if (!src) continue;

    const id = `te-img-${index++}`;
    img.dataset.translateExtId = id;

    out.push({
      id,
      src,
      width: Math.round(w),
      height: Math.round(h),
      visible: isInViewport(rect),
    });
  }

  return out;
}

function isInViewport(r: DOMRect): boolean {
  return (
    r.bottom > 0 &&
    r.right > 0 &&
    r.top < (window.innerHeight || document.documentElement.clientHeight) &&
    r.left < (window.innerWidth || document.documentElement.clientWidth)
  );
}

/** Найти <img> по нашему data-атрибуту (для позиционирования подписей). */
export function findImageElement(id: string): HTMLImageElement | null {
  return document.querySelector<HTMLImageElement>(`img[data-translate-ext-id="${id}"]`);
}

/** Причина сбоя загрузки изображения (CORS-фейл не отдаёт статус — см. `kind`). */
export interface ImageFetchFailure {
  kind: 'http' | 'cors' | 'network';
  status?: number;
  detail: string;
}

export type ImageFetchResult = { ok: true; blob: Blob } | ({ ok: false } & ImageFetchFailure);

/**
 * Загрузить сырые байты изображения.
 * Работает для same-origin и CORS-enabled источников; при сбое возвращает
 * структурированную причину (вызывающая сторона предлагает скриншот-флоу).
 */
export async function fetchImageBlob(src: string): Promise<ImageFetchResult> {
  try {
    const res = await fetch(src, { credentials: 'omit', mode: 'cors' });
    if (!res.ok) {
      return { ok: false, kind: 'http', status: res.status, detail: `HTTP ${res.status}` };
    }
    return { ok: true, blob: await res.blob() };
  } catch (e) {
    // CORS/Cloudflare-сбои маскируются браузером под «TypeError: Failed to fetch»:
    // статус через fetch недоступен, вызывающая сторона предлагает скриншот-флоу.
    return { ok: false, kind: 'cors', detail: String((e as Error)?.name ?? 'Error') };
  }
}

/** Превратить data URL (например, из captureVisibleTab) в Blob. */
export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return await res.blob();
}

/**
 * Обрезать скриншот И замаскировать его формой выделения.
 *
 * `region.bounds` / `region.points` — в координатах ДОКУМЕНТА, а скриншот —
 * видимая часть в device-пикселях. `scrollAtCapture` — scroll на момент
 * скриншота; без него скролл между выделением и Enter вырезает чужой кусок.
 *
 * Маска (прямоугольник / овал / лассо) заливает всё вне формы белым, поэтому
 * соседние арты и рамки панелей не попадают ни в OCR, ни в vision-модель.
 */
export async function cropRegion(
  dataUrl: string,
  region: SelectionRegion,
  scrollAtCapture: { x: number; y: number } = { x: 0, y: 0 },
): Promise<Blob> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = bitmap.width / window.innerWidth;
  const viewport = regionToViewport(region.bounds, scrollAtCapture);
  const b = viewport;

  const sx = Math.max(0, Math.round(b.x * scale));
  const sy = Math.max(0, Math.round(b.y * scale));
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(b.width * scale)));
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(b.height * scale)));

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');

  // Белая подложка: прозрачные пиксели PNG не путают vision-модели.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, sw, sh);

  // CSS-пиксели вьюпорта -> локальные device-пиксели канвы.
  // Точки лассо хранятся в документных — приводим к вьюпорту кадра.
  const local = (p: Point): Point => ({
    x: (p.x - scrollAtCapture.x) * scale - sx,
    y: (p.y - scrollAtCapture.y) * scale - sy,
  });

  ctx.save();
  ctx.beginPath();
  if (region.shape === 'oval') {
    ctx.ellipse(sw / 2, sh / 2, sw / 2, sh / 2, 0, 0, Math.PI * 2);
  } else if (region.shape === 'lasso' && region.points && region.points.length > 2) {
    const pts = region.points.map(local);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.closePath();
  } else {
    ctx.rect(0, 0, sw, sh);
  }
  ctx.clip();
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  ctx.restore();

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png'),
  );
}
