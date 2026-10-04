import type { Box, CaptureVisibleResponse, TranslateResult } from './types';

export interface ViewportFrame {
  scrollX: number; scrollY: number;
  width: number; height: number;
  pixelRatio: number;
}

export function readViewportFrame(): ViewportFrame {
  return { scrollX: window.scrollX, scrollY: window.scrollY, width: window.innerWidth,
    height: window.innerHeight, pixelRatio: window.devicePixelRatio || 1 };
}

export function sameViewport(a: ViewportFrame, b: ViewportFrame): boolean {
  return a.scrollX === b.scrollX && a.scrollY === b.scrollY && sameViewportSize(a, b);
}

export function sameViewportSize(a: ViewportFrame, b: ViewportFrame): boolean {
  return a.width === b.width && a.height === b.height && a.pixelRatio === b.pixelRatio;
}

export function snapshotBoxesToDocument(boxes: readonly Box[], frame: ViewportFrame,
  imageWidth: number, imageHeight: number): Box[] {
  if (![imageWidth, imageHeight, frame.width, frame.height].every(v => Number.isFinite(v) && v > 0)
      || ![frame.scrollX, frame.scrollY, frame.pixelRatio].every(Number.isFinite)) return [];
  const sx = frame.width / imageWidth, sy = frame.height / imageHeight;
  return boxes.filter(b => [b.x, b.y, b.width, b.height].every(Number.isFinite)
    && b.width > 0 && b.height > 0 && (b.translation ?? '').trim()).flatMap(b => {
    const x = Math.max(0, b.x), y = Math.max(0, b.y);
    const right = Math.min(imageWidth, b.x + b.width), bottom = Math.min(imageHeight, b.y + b.height);
    if (right <= x || bottom <= y) return [];
    return [{ ...b, x: frame.scrollX + x * sx, y: frame.scrollY + y * sy,
      width: (right - x) * sx, height: (bottom - y) * sy }];
  });
}

export async function dataUrlImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('Screenshot decode failed'));
    image.src = dataUrl;
  });
}

interface ViewportDependencies {
  frame: () => ViewportFrame;
  capture: () => Promise<CaptureVisibleResponse>;
  size: (dataUrl: string) => Promise<{ width: number; height: number }>;
  translate: (dataUrl: string) => Promise<TranslateResult>;
  render: (frame: ViewportFrame, size: { width: number; height: number }, result: TranslateResult) => void;
  isCurrent: () => boolean;
}

/** Snapshot position is frozen before capture, not after a slow network reply.
 * A moved/resized frame DURING capture is rejected; scrolling during translation
 * is safe because output anchors live in document coordinates. Caller owns generation.
 */
export async function translateViewport(deps: ViewportDependencies): Promise<TranslateResult> {
  const failure = (error: string): TranslateResult => ({ source_text: '', translation: '',
    model: 'n/a', latency_ms: 0, error });
  try {
    const frame = deps.frame();
    const capture = await deps.capture();
    if (!capture.dataUrl) return failure(capture.error ?? 'Screenshot capture failed');
    if (!sameViewport(frame, deps.frame())) return failure('Page moved during capture; retry without scrolling');
    if (!deps.isCurrent()) return failure('Screenshot translation was superseded');
    const size = await deps.size(capture.dataUrl);
    if (!(size.width > 0 && size.height > 0)) return failure('Screenshot has invalid dimensions');
    const result = await deps.translate(capture.dataUrl);
    if (!deps.isCurrent()) return failure('Screenshot translation was superseded');
    if (!sameViewportSize(frame, deps.frame())) return failure('Viewport resized or zoomed; capture again');
    if (!result.error) deps.render(frame, size, result);
    return result;
  } catch (error) { return failure(String(error)); }
}
