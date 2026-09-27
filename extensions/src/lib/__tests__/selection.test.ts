import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  initialBubbleFontSize,
  lassoPathData,
  mapBoxToViewport,
  regionKey,
  regionToViewport,
} from '../selection';

describe('boundsOf', () => {
  it('computes the box around a point cloud', () => {
    const b = boundsOf([
      { x: 30, y: 40 },
      { x: 10, y: 90 },
      { x: 50, y: 20 },
    ]);
    expect(b).toEqual({ x: 10, y: 20, width: 40, height: 70 });
  });

  it('returns a zero box for a single point', () => {
    expect(boundsOf([{ x: 5, y: 7 }])).toEqual({ x: 5, y: 7, width: 0, height: 0 });
  });

  it('handles an empty input without throwing', () => {
    expect(boundsOf([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('lassoPathData', () => {
  it('builds a closed path through every point', () => {
    const d = lassoPathData([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { x: 5, y: 6 },
    ]);
    expect(d).toBe('M 1 2 L 3 4 L 5 6 Z');
  });

  it('returns an empty path when there is nothing to close', () => {
    expect(lassoPathData([])).toBe('');
    expect(lassoPathData([{ x: 1, y: 2 }])).toBe('');
  });
});

describe('mapBoxToViewport', () => {
  const imageRect = { left: 100, top: 50, width: 500, height: 250 };

  it('scales image-space boxes to the rendered image', () => {
    // source image 2000x1000 rendered into a 500x250 rect → scale 0.25
    const vp = mapBoxToViewport({ x: 400, y: 200, width: 400, height: 200 }, imageRect, 2000, 1000);
    expect(vp).toEqual({ left: 200, top: 100, width: 100, height: 50 });
  });

  it('enforces a minimum usable bubble size', () => {
    const vp = mapBoxToViewport({ x: 0, y: 0, width: 1, height: 1 }, imageRect, 2000, 1000);
    expect(vp.width).toBe(30);
    expect(vp.height).toBe(26);
  });

  it('degrades gracefully when natural sizes are unknown', () => {
    const vp = mapBoxToViewport({ x: 10, y: 10, width: 10, height: 10 }, imageRect, 0, 0);
    expect(vp).toEqual({ left: 100, top: 50, width: 0, height: 0 });
  });
});

describe('initialBubbleFontSize', () => {
  it('grows with the bubble height', () => {
    expect(initialBubbleFontSize(120)).toBeGreaterThan(initialBubbleFontSize(40));
  });

  it('never goes above the readable maximum', () => {
    expect(initialBubbleFontSize(2000)).toBeLessThanOrEqual(20);
  });

  it('never drops below the minimum for tiny bubbles', () => {
    expect(initialBubbleFontSize(1)).toBeGreaterThanOrEqual(9);
  });
});

describe('regionToViewport', () => {
  it('subtracts the capture-time scroll from document bounds', () => {
    // Выделил на scroll 0, проскроллил на 300, нажал Enter — кроп берёт то же место.
    const vp = regionToViewport({ x: 100, y: 400, width: 200, height: 120 }, { x: 0, y: 300 });
    expect(vp).toEqual({ x: 100, y: 100, width: 200, height: 120 });
  });

  it('leaves bounds untouched when nothing scrolled', () => {
    const vp = regionToViewport({ x: 10, y: 20, width: 30, height: 40 }, { x: 0, y: 0 });
    expect(vp).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it('clamps bounds when region is partially or completely offscreen', () => {
    const viewportSize = { width: 800, height: 600 };

    // Частично вылезает слева и сверху
    const partialTopLeft = regionToViewport(
      { x: 50, y: 50, width: 100, height: 100 },
      { x: 100, y: 100 },
      viewportSize,
    );
    expect(partialTopLeft).toEqual({ x: 0, y: 0, width: 50, height: 50 });

    // Частично вылезает справа и снизу
    const partialBottomRight = regionToViewport(
      { x: 750, y: 550, width: 100, height: 100 },
      { x: 0, y: 0 },
      viewportSize,
    );
    expect(partialBottomRight).toEqual({ x: 750, y: 550, width: 50, height: 50 });

    // Полностью ушло за экран (скролл дальше всей области)
    const fullyOffscreen = regionToViewport(
      { x: 100, y: 100, width: 100, height: 100 },
      { x: 300, y: 300 },
      viewportSize,
    );
    expect(fullyOffscreen).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('regionKey', () => {
  it('prefers region id when present', () => {
    expect(
      regionKey({
        id: 'r42',
        shape: 'rectangle',
        bounds: { x: 10, y: 20, width: 30, height: 40 },
      }),
    ).toBe('r42');
  });

  it('generates deterministic shape-and-bounds key when id is missing', () => {
    expect(
      regionKey({
        shape: 'oval',
        bounds: { x: 15, y: 25, width: 35, height: 45 },
      }),
    ).toBe('oval:15,25,35,45');
  });
});
