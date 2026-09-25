import type { Box, Point } from './types';

/** Прямоугольник, параллельный осям, в CSS-пикселях. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Позиционированный прямоугольник в координатах вьюпорта (CSS px) для `position: fixed`. */
export interface ViewportBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Описанная прямоугольником (AABB) область облака точек.
 * На пустом входе возвращает прямоугольник нулевого размера, а не исключение.
 */
export function boundsOf(points: Point[]): Bounds {
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };

  let minX = points[0].x;
  let minY = points[0].y;
  let maxX = points[0].x;
  let maxY = points[0].y;

  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** SVG-путь лассо (`M x y L x y … Z`) для замкнутого контура от руки. */
export function lassoPathData(points: Point[]): string {
  if (points.length < 2) return '';
  return `M ${points.map((p) => `${p.x} ${p.y}`).join(' L ')} Z`;
}

/**
 * Отобразить текстовый прямоугольник в пиксельном пространстве исходного
 * изображения на прямоугольник вьюпорта, который сейчас занимает отрисованный
 * <img>. Используется для позиционирования речевых пузырей так, чтобы они
 * следовали за скроллом и ресайзом.
 */
export function mapBoxToViewport(
  box: Pick<Box, 'x' | 'y' | 'width' | 'height'>,
  imageRect: ViewportBox,
  naturalWidth: number,
  naturalHeight: number,
): ViewportBox {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return { left: imageRect.left, top: imageRect.top, width: 0, height: 0 };
  }
  const sx = imageRect.width / naturalWidth;
  const sy = imageRect.height / naturalHeight;

  return {
    left: imageRect.left + box.x * sx,
    top: imageRect.top + box.y * sy,
    width: Math.max(30, box.width * sx),
    height: Math.max(26, box.height * sy),
  };
}

/** Стартовый размер шрифта пузыря заданной высоты (до подгонки). */
export function initialBubbleFontSize(height: number, padding = 6): number {
  const available = Math.max(14, height - padding * 2);
  return Math.max(9, Math.min(20, Math.floor(available / 2.6)));
}
