import { describe, expect, it, vi } from 'vitest';
import { groupDialogueBoxes, rasterSeparator, refineDialogueBoxes } from '../dialogueGroups';
import type { Box } from '../../types';
const line = (text: string, x = 10, y = 10, width = 80, height = 12): Box => ({ text, x, y, width, height });

describe('groupDialogueBoxes', () => {
  it('groups a whole manga speech bubble before translation', () => {
    const words = ['YOUR LUX', 'IS', 'THE ABILITY', 'TO SEE THROUGH', 'FALSE-', 'HOODS?'];
    const boxes = words.map((text, i) => line(text, 10, 10 + i * 17));
    expect(groupDialogueBoxes(boxes)).toEqual([{ x: 10, y: 10, width: 80, height: 97,
      text: 'YOUR LUX IS THE ABILITY TO SEE THROUGH FALSEHOODS?' }]);
  });
  it('does not join side-by-side balloons or change the source boxes', () => {
    const boxes = [line('RIGHT', 150), line('LEFT'), line('SIDE', 150, 27), line('SIDE', 10, 27)];
    const before = JSON.stringify(boxes);
    expect(groupDialogueBoxes(boxes).map(b => b.text)).toEqual(['LEFT SIDE', 'RIGHT SIDE']);
    expect(JSON.stringify(boxes)).toBe(before);
  });
  it('separates vertically distant dialogue', () => {
    expect(groupDialogueBoxes([line('ONE'), line('TWO', 10, 40)])).toHaveLength(2);
  });
  it('checks the gap immediately before, at and after the grouping boundary', () => {
    expect(groupDialogueBoxes([line('ONE'), line('TWO', 10, 32.79)])).toHaveLength(1);
    expect(groupDialogueBoxes([line('ONE'), line('TWO', 10, 32.8)])).toHaveLength(1);
    expect(groupDialogueBoxes([line('ONE'), line('TWO', 10, 32.81)])).toHaveLength(2);
  });
  it('uses a border veto to keep close text stacks in separate bubbles', () => {
    const separates = vi.fn(() => true);
    expect(groupDialogueBoxes([line('FIRST'), line('SECOND', 10, 27)], separates)).toHaveLength(2);
    expect(separates).toHaveBeenCalledWith(line('FIRST'), line('SECOND', 10, 27));
  });
  it('does not bridge a huge font change', () => {
    expect(groupDialogueBoxes([line('Small'), line('TITLE', 10, 27, 80, 36)])).toHaveLength(2);
  });
  it('rejects invalid rectangles and graphics-only symbols, preserves real short dialogue', () => {
    const boxes = [line('\\'), line('<'), line('BAD', NaN), line('ZERO', 10, 10, 0),
      line('I'), line('?!', 200), line('42', 300)];
    expect(groupDialogueBoxes(boxes).map(b => b.text)).toEqual(['I', '?!', '42']);
  });
  it('handles empty input and one multiline region', () => {
    expect(groupDialogueBoxes([])).toEqual([]);
    expect(groupDialogueBoxes([line('Hello\nthere')])[0].text).toBe('Hello there');
  });
});

describe('rasterSeparator', () => {
  it('vetoes a dense border but not white space or a small ink speck', () => {
    const pixels = new Uint8ClampedArray(100 * 60 * 4).fill(255);
    const upper = line('ONE'), lower = line('TWO', 10, 29);
    const separates = rasterSeparator(pixels, 100, 60);
    expect(separates(upper, lower)).toBe(false);
    pixels.fill(0, (25 * 100 + 20) * 4, (25 * 100 + 21) * 4);
    pixels[(25 * 100 + 20) * 4 + 3] = 255;
    expect(separates(upper, lower)).toBe(false);
    for (let x = 10; x < 90; x++) {
      const p = (25 * 100 + x) * 4; pixels[p] = pixels[p + 1] = pixels[p + 2] = 0;
    }
    expect(separates(upper, lower)).toBe(true);
  });
  it('does not read outside the raster for edge boxes', () => {
    expect(rasterSeparator(new Uint8ClampedArray(40), 5, 2)(line('A', -30), line('B', -30, 30))).toBe(false);
  });
});

describe('refineDialogueBoxes', () => {
  it('uses a successful crop result without losing page coordinates', async () => {
    const box = line('couLp 17');
    const recognize = vi.fn().mockResolvedValue({ text: 'COULD IT\nBE THAT', confidence: 90 });
    expect(await refineDialogueBoxes([box], recognize, 40)).toEqual([{ ...box, text: 'COULD IT BE THAT' }]);
    expect(recognize).toHaveBeenCalledWith(box);
  });
  it('preserves discovery when a crop fails, is empty or is below confidence', async () => {
    const boxes = [line('A'), line('B'), line('C')];
    const recognize = vi.fn().mockRejectedValueOnce(new Error('worker'))
      .mockResolvedValueOnce({ text: '', confidence: 99 }).mockResolvedValueOnce({ text: 'wrong', confidence: 39 });
    expect(await refineDialogueBoxes(boxes, recognize, 40)).toEqual(boxes);
  });
  it('accepts crop confidence exactly at the threshold and skips empty input', async () => {
    const recognize = vi.fn().mockResolvedValue({ text: 'correct', confidence: 40 });
    expect((await refineDialogueBoxes([line('old')], recognize, 40))[0].text).toBe('correct');
    recognize.mockClear(); expect(await refineDialogueBoxes([], recognize, 40)).toEqual([]);
    expect(recognize).not.toHaveBeenCalled();
  });
});
