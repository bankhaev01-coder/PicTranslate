import { describe, expect, it } from 'vitest';
import { MAX_CAPTURE_DPR, MAX_CROP_SIDE, computeCropSize } from '../scanner';

describe('computeCropSize', () => {
  const vp = { width: 800, height: 600 };

  it('keeps DPR 1 crops untouched', () => {
    const g = computeCropSize(
      { width: 800, height: 600 },
      { x: 100, y: 80, width: 300, height: 200 },
      vp,
    );
    expect(g.effScale).toBe(1);
    expect(g).toMatchObject({ sx: 100, sy: 80, sw: 300, sh: 200, outW: 300, outH: 200 });
  });

  it('caps DPR at MAX_CAPTURE_DPR (retina 3x -> 2x)', () => {
    const g = computeCropSize(
      { width: 2400, height: 1800 },
      { x: 100, y: 80, width: 300, height: 200 },
      vp,
    );
    expect(g.effScale).toBe(MAX_CAPTURE_DPR);
    // 300 CSS px * 2 вместо 300 * 3: в 2.25 раза меньше пикселей.
    expect(g).toMatchObject({ sx: 200, sy: 160, sw: 600, sh: 400, outW: 600, outH: 400 });
  });

  it('passes fractional DPR through when under the cap', () => {
    const g = computeCropSize(
      { width: 1200, height: 900 },
      { x: 10, y: 10, width: 100, height: 50 },
      vp,
    );
    expect(g.effScale).toBe(1.5);
    expect(g).toMatchObject({ sx: 15, sy: 15, sw: 150, sh: 75, outW: 150, outH: 75 });
  });

  it('downscales the long side to MAX_CROP_SIDE keeping proportions', () => {
    // Панорамная область 3000x500 (DPR 1): длинная 3000 -> 1600.
    const g = computeCropSize(
      { width: 3200, height: 600 },
      { x: 0, y: 0, width: 3000, height: 500 },
      { width: 3200, height: 600 },
    );
    expect(g.sw).toBe(3000);
    expect(g.sh).toBe(500);
    expect(g.outW).toBe(MAX_CROP_SIDE);
    // 500 * 1600/3000 = 266.67 -> 267
    expect(g.outH).toBe(267);
  });

  it('downscales the tall side when height is the long side', () => {
    const g = computeCropSize(
      { width: 600, height: 3200 },
      { x: 0, y: 0, width: 500, height: 3000 },
      { width: 600, height: 3200 },
    );
    expect(g.outH).toBe(MAX_CROP_SIDE);
    expect(g.outW).toBe(267);
  });

  it('leaves small crops untouched', () => {
    const g = computeCropSize(
      { width: 1600, height: 1200 },
      { x: 50, y: 50, width: 400, height: 300 },
      vp,
    );
    expect(g.outW).toBe(g.sw);
    expect(g.outH).toBe(g.sh);
    expect(g.outW).toBeLessThanOrEqual(MAX_CROP_SIDE);
    expect(g.outH).toBeLessThanOrEqual(MAX_CROP_SIDE);
  });

  it('clamps the cut to the bitmap edges', () => {
    const g = computeCropSize(
      { width: 800, height: 600 },
      { x: 700, y: 500, width: 300, height: 300 },
      vp,
    );
    expect(g.sx + g.sw).toBeLessThanOrEqual(800);
    expect(g.sy + g.sh).toBeLessThanOrEqual(600);
    expect(g.sw).toBeGreaterThanOrEqual(1);
    expect(g.sh).toBeGreaterThanOrEqual(1);
  });

  it('keeps lasso points inside the canvas after DPR cap and downscale', () => {
    // Ретина DPR 3 -> кап 2. В реальном потоке широкая область сначала режется
    // regionToViewport по вьюпорту 800: вход уже клампнут (800x100 CSS).
    // Вырезка 1600x200 -> fit 1, маска лассо ложится 1:1 в канву.
    const g = computeCropSize(
      { width: 2400, height: 1800 },
      { x: 0, y: 0, width: 800, height: 100 },
      vp,
    );
    expect(g.effScale).toBe(2);
    expect(g).toMatchObject({ sw: 1600, sh: 200, outW: 1600, outH: 200 });
    // Локальная координата правого края области в канве: (800*2 - 0) * 1 = 1600.
    const fit = g.outW / g.sw;
    const lx = (800 * g.effScale - g.sx) * fit;
    const ly = (100 * g.effScale - g.sy) * fit;
    expect(lx).toBeLessThanOrEqual(g.outW);
    expect(ly).toBeLessThanOrEqual(g.outH);
    expect(lx).toBeGreaterThanOrEqual(0);
    expect(ly).toBeGreaterThanOrEqual(0);
  });

  it('scales lasso points with fit when the long side is downscaled', () => {
    // Панорама 3000x500 (DPR 1) -> fit 1600/3000: точка правого края
    // (3000*1 - 0) * fit = 1600 — ровно край канвы, маска не съезжает.
    const g = computeCropSize(
      { width: 3200, height: 600 },
      { x: 0, y: 0, width: 3000, height: 500 },
      { width: 3200, height: 600 },
    );
    const fit = g.outW / g.sw;
    const lx = (3000 * g.effScale - g.sx) * fit;
    const ly = (500 * g.effScale - g.sy) * fit;
    expect(lx).toBeLessThanOrEqual(g.outW);
    expect(ly).toBeLessThanOrEqual(g.outH);
  });
});
