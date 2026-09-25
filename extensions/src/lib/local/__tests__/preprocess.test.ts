import { describe, expect, it } from 'vitest';
import { grayscaleInPlace } from '../preprocess';

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
