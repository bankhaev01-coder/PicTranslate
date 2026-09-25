import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  initialBubbleFontSize,
  lassoPathData,
  mapBoxToViewport,
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
