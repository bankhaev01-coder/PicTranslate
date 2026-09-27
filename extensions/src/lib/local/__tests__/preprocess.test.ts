import { describe, expect, it } from 'vitest';
import {
  binarizeOtsuInPlace,
  binarizeSauvolaInPlace,
  grayscaleInPlace,
  invertInPlace,
  normalizeContrastInPlace,
  upscaleToMinTextHeight,
} from '../preprocess';

describe('grayscaleInPlace', () => {
  it('converts pure red to BT.601 luma (76)', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255]);
    grayscaleInPlace(rgba);
    expect([...rgba]).toEqual([76, 76, 76, 255]); // alpha untouched
  });

  it('keeps white and black unchanged', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 128, 0, 0, 0, 128]);
    grayscaleInPlace(rgba);
    expect(rgba[0]).toBe(255);
    expect(rgba[3]).toBe(128);
    expect(rgba[4]).toBe(0);
    expect(rgba[7]).toBe(128);
  });

  it('uses BT.601 coefficients (same as PIL/backend)', () => {
    const rgba = new Uint8ClampedArray([10, 20, 30, 255]);
    grayscaleInPlace(rgba);
    const expected = Math.floor(0.299 * 10 + 0.587 * 20 + 0.114 * 30);
    expect(rgba[0]).toBe(expected);
    expect(rgba[1]).toBe(expected);
    expect(rgba[2]).toBe(expected);
  });

  it('ignores trailing bytes that do not form a pixel', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 9]);
    grayscaleInPlace(rgba);
    expect(rgba[4]).toBe(9);
  });
});

describe('normalizeContrastInPlace', () => {
  it('stretches low-contrast range [100, 200] to [0, 255]', () => {
    const rgba = new Uint8ClampedArray([
      100, 100, 100, 255,
      200, 200, 200, 255,
      150, 150, 150, 255,
    ]);
    normalizeContrastInPlace(rgba);
    expect(rgba[0]).toBe(0); // min -> 0
    expect(rgba[4]).toBe(255); // max -> 255
    expect(rgba[8]).toBe(128); // midpoint -> 128
    // alpha channels untouched
    expect(rgba[3]).toBe(255);
    expect(rgba[7]).toBe(255);
    expect(rgba[11]).toBe(255);
  });

  it('does nothing on uniform pixel buffer (min == max)', () => {
    const rgba = new Uint8ClampedArray([100, 100, 100, 255, 100, 100, 100, 255]);
    normalizeContrastInPlace(rgba);
    expect(rgba[0]).toBe(100);
    expect(rgba[4]).toBe(100);
  });
});

describe('binarizeOtsuInPlace', () => {
  it('correctly separates bimodal histogram into 0 and 255', () => {
    // 5 dark pixels (value 20) and 5 bright pixels (value 230)
    const rgba = new Uint8ClampedArray([
      20, 20, 20, 255,
      20, 20, 20, 255,
      20, 20, 20, 255,
      20, 20, 20, 255,
      20, 20, 20, 255,
      230, 230, 230, 255,
      230, 230, 230, 255,
      230, 230, 230, 255,
      230, 230, 230, 255,
      230, 230, 230, 255,
    ]);
    binarizeOtsuInPlace(rgba);
    expect(rgba[0]).toBe(0);
    expect(rgba[1]).toBe(0);
    expect(rgba[2]).toBe(0);
    expect(rgba[3]).toBe(255); // alpha untouched

    expect(rgba[20]).toBe(255);
    expect(rgba[21]).toBe(255);
    expect(rgba[22]).toBe(255);
    expect(rgba[23]).toBe(255);
  });

  it('handles empty or zero-length buffer safely', () => {
    const rgba = new Uint8ClampedArray([]);
    binarizeOtsuInPlace(rgba);
    expect(rgba.length).toBe(0);
  });
});

describe('upscaleToMinTextHeight', () => {
  it('returns original canvas if dimensions are already >= minDimension', () => {
    const canvas = { width: 500, height: 400 } as HTMLCanvasElement;
    const res = upscaleToMinTextHeight(canvas, 300);
    expect(res).toBe(canvas);
  });

  it('returns original canvas if canvas has zero size', () => {
    const canvas = { width: 0, height: 0 } as HTMLCanvasElement;
    const res = upscaleToMinTextHeight(canvas, 300);
    expect(res).toBe(canvas);
  });
});

describe('invertInPlace', () => {
  it('inverts RGB and keeps alpha', () => {
    const rgba = new Uint8ClampedArray([0, 128, 255, 128]);
    invertInPlace(rgba);
    expect([...rgba]).toEqual([255, 127, 0, 128]);
  });

  it('is its own inverse (double inversion = identity)', () => {
    const rgba = new Uint8ClampedArray([10, 20, 30, 255, 200, 100, 50, 77]);
    const before = [...rgba];
    invertInPlace(rgba);
    invertInPlace(rgba);
    expect([...rgba]).toEqual(before);
  });
});

describe('binarizeSauvolaInPlace', () => {
  it('keeps dark text pixels black and bright background white', () => {
    // 8×8: фон 230, тёмные «буквы» 40 по центру.
    const w = 8;
    const h = 8;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = x >= 3 && x <= 4 ? 40 : 230;
        const i = (y * w + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
        rgba[i + 3] = 255;
      }
    }
    binarizeSauvolaInPlace(rgba, w, h, 3);
    const at = (x: number, y: number) => rgba[(y * w + x) * 4];
    expect(at(0, 0)).toBe(255); // фон
    expect(at(7, 7)).toBe(255);
    expect(at(3, 4)).toBe(0); // текст
    expect(at(4, 4)).toBe(0);
    expect(rgba[3]).toBe(255); // альфа не тронута
  });

  it('handles zero-size buffers safely', () => {
    const rgba = new Uint8ClampedArray([]);
    binarizeSauvolaInPlace(rgba, 0, 0);
    expect(rgba.length).toBe(0);
  });
});
