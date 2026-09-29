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

  it('caps the output at MAX_CAPTURE_DPR without shifting the crop (retina 3x)', () => {
    const g = computeCropSize(
      { width: 2400, height: 1800 },
      { x: 100, y: 80, width: 300, height: 200 },
      vp,
    );
    // Позиция вырезки — по истинному масштабу кадра: 100 CSS px * 3 = 300 device-px.
    expect(g.effScale).toBe(3);
    expect(g).toMatchObject({ sx: 300, sy: 240, sw: 900, sh: 600 });
    // Выход ужат до 2x от CSS-размера: 300 CSS px -> 600 px (а не 900).
    expect(g).toMatchObject({
      outW: 300 * MAX_CAPTURE_DPR,
      outH: 200 * MAX_CAPTURE_DPR,
    });
    // Маска лассо ложится в канву: правый край области — ровно правый край вырезки.
    const fit = g.outW / g.sw;
    expect((400 * g.effScale - g.sx) * fit).toBe(g.outW);
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

  it('keeps lasso points inside the canvas after the DPR cap and downscale', () => {
    // Ретина DPR 3, кап выхода 2x. Область 800x100 CSS: вырезка 2400x300 по
    // истинному масштабу, канва ужимается до 1600x200.
    const g = computeCropSize(
      { width: 2400, height: 1800 },
      { x: 0, y: 0, width: 800, height: 100 },
      vp,
    );
    expect(g.effScale).toBe(3);
    expect(g).toMatchObject({ sw: 2400, sh: 300, outW: 1600, outH: 200 });
    // Локальная координата правого края области в канве: (800*3 - 0) * fit = 1600.
    const fit = g.outW / g.sw;
    const lx = (800 * g.effScale - g.sx) * fit;
    const ly = (100 * g.effScale - g.sy) * fit;
    expect(lx).toBeLessThanOrEqual(g.outW);
    expect(ly).toBeLessThanOrEqual(g.outH);
    expect(lx).toBeGreaterThanOrEqual(0);
    expect(ly).toBeGreaterThanOrEqual(0);
  });

  it('keeps the crop aligned when the page is zoomed out (scale below 1)', () => {
    // Зум 80 %: вьюпорт 1280 CSS px, а кадр — 1024 device-px (DPR 1).
    const zoomOutVp = { width: 1280, height: 960 };
    const g = computeCropSize(
      { width: 1024, height: 768 },
      { x: 100, y: 100, width: 200, height: 100 },
      zoomOutVp,
    );
    expect(g.effScale).toBe(0.8);
    expect(g).toMatchObject({ sx: 80, sy: 80, sw: 160, sh: 80 });
    // Выход не растягиваем: пиксели канвы — device-px кадра, 1:1.
    expect(g.outW).toBe(160);
    expect(g.outH).toBe(80);
  });

  it('applies the DPR cap and the long-side cap together on the true scale', () => {
    // DPR 3 и широкое выделение 1000x200 CSS: вырезка 3000x600, канва — 1600.
    const g = computeCropSize(
      { width: 3000, height: 1000 },
      { x: 0, y: 0, width: 1000, height: 200 },
      { width: 1000, height: 333 },
    );
    expect(g.effScale).toBe(3);
    expect(g).toMatchObject({ sw: 3000, sh: 600, outW: MAX_CROP_SIDE, outH: 320 });
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
