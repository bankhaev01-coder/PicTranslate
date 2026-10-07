import type { Box, JapaneseOcrLayout } from '../types';
import { joinOcrLines } from './text';

/** Raster barrier check is optional for native OCR; coordinates are image pixels. */
export type SeparatesLines = (upper: Box, lower: Box) => boolean;

export function validTextBox(box: Box): boolean {
  return [box.x, box.y, box.width, box.height].every(Number.isFinite)
    && box.width > 0 && box.height > 0 && /[\p{L}\p{N}!?…。、]/u.test(box.text ?? '');
}

/** Conservative horizontal-dialogue grouping, not a universal balloon detector.
 * Lines must overlap horizontally, have aligned centres and a small vertical gap.
 * Never combines same-row neighbouring columns. Optional raster veto keeps a
 * panel/bubble border between two close text stacks from being crossed.
 */
export function groupDialogueBoxes(boxes: readonly Box[], separates?: SeparatesLines,
  layout: JapaneseOcrLayout = 'auto'): Box[] {
  const valid = boxes.filter(validTextBox).map(b => ({ ...b, text: (b.text ?? '').trim() }));
  const vertical = valid.filter(box => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}。、]/u.test(box.text ?? ''));
  const tallJapanese = vertical.filter(box => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(box.text ?? '')
    && box.height >= box.width * 1.2);
  const verticalMode = vertical.length > 0
    && (layout === 'vertical' || (layout === 'auto' && tallJapanese.length >= 2));
  if (verticalMode) {
    const glyphWidth = Math.max(...vertical.map(box => box.width));
    const columns: Box[][] = [];
    for (const glyph of [...vertical].sort((a, b) => b.x - a.x || a.y - b.y)) {
      const column = columns.find(items => {
        const nearest = items[items.length - 1];
        return Math.abs((nearest.x + nearest.width / 2) - (glyph.x + glyph.width / 2)) <= glyphWidth * 1.25
          && glyph.y >= nearest.y + nearest.height - glyph.height * 0.25
          && glyph.y - (nearest.y + nearest.height) <= glyph.height * 0.9
          && !separates?.(nearest, glyph);
      });
      if (column) column.push(glyph); else columns.push([glyph]);
    }
    const orderedColumns = columns.map(column => {
      const x = Math.min(...column.map(box => box.x));
      const y = Math.min(...column.map(box => box.y));
      return { boxes: column, x, y,
        width: Math.max(...column.map(box => box.x + box.width)) - x,
        height: Math.max(...column.map(box => box.y + box.height)) - y };
    });
    const columnGap = orderedColumns.length > 1
      ? orderedColumns[0].x - (orderedColumns[1].x + orderedColumns[1].width)
      : Infinity;
    if (orderedColumns.length > 1 && columnGap <= glyphWidth * 3) {
      const boxesInReadingOrder = orderedColumns.flatMap(column => column.boxes.sort((a, b) => a.y - b.y));
      const x = Math.min(...boxesInReadingOrder.map(box => box.x));
      const y = Math.min(...boxesInReadingOrder.map(box => box.y));
      return [{ x, y,
        width: Math.max(...boxesInReadingOrder.map(box => box.x + box.width)) - x,
        height: Math.max(...boxesInReadingOrder.map(box => box.y + box.height)) - y,
        text: boxesInReadingOrder.map(box => box.text ?? '').join('') }];
    }
    return orderedColumns.map(column => ({ ...column, text: column.boxes
      .sort((a, b) => a.y - b.y).map(box => box.text ?? '').join('') }));
  }
  const sorted = valid.sort((a, b) => a.y - b.y || a.x - b.x);
  const groups: Box[][] = [];
  for (const line of sorted) {
    let chosen: Box[] | undefined;
    let nearest = Infinity;
    for (const group of groups) {
      const last = group[group.length - 1];
      const minHeight = Math.min(last.height, line.height);
      const gap = line.y - (last.y + last.height);
      const overlap = Math.min(last.x + last.width, line.x + line.width) - Math.max(last.x, line.x);
      const centreDistance = Math.abs(last.x + last.width / 2 - line.x - line.width / 2);
      const heightRatio = Math.max(last.height, line.height) / minHeight;
      // Slight bbox overlap is common in OCR. A whole same-row box is not another line.
      if (line.y - last.y < minHeight * 0.55 || gap < -minHeight * 0.25
          || gap > minHeight * 0.9 || heightRatio > 2.2
          || overlap < Math.min(last.width, line.width) * 0.45
          || centreDistance > Math.max(last.width, line.width) * 0.45
          || separates?.(last, line)) continue;
      const left = Math.min(...group.map(b => b.x), line.x);
      const right = Math.max(...group.map(b => b.x + b.width), line.x + line.width);
      const maxWidth = Math.max(...group.map(b => b.width), line.width);
      if (right - left > maxWidth * 1.35) continue;
      if (gap < nearest) { chosen = group; nearest = gap; }
    }
    if (chosen) chosen.push(line); else groups.push([line]);
  }
  return groups.map(group => {
    const x = Math.min(...group.map(b => b.x));
    const y = Math.min(...group.map(b => b.y));
    return {
      x, y,
      width: Math.max(...group.map(b => b.x + b.width)) - x,
      height: Math.max(...group.map(b => b.y + b.height)) - y,
      text: joinOcrLines(group.map(b => b.text ?? '').join('\n')),
    };
  });
}

/** Reject a dense horizontal ink barrier in the gap (panel or balloon boundary).
 * Check only overlapping columns; punctuation/noise is not enough to veto.
 */
export function rasterSeparator(rgba: Uint8ClampedArray, width: number, height: number): SeparatesLines {
  return (upper, lower) => {
    const x0 = Math.max(0, Math.ceil(Math.max(upper.x, lower.x)));
    const x1 = Math.min(width, Math.floor(Math.min(upper.x + upper.width, lower.x + lower.width)));
    const y0 = Math.max(0, Math.ceil(upper.y + upper.height + 1));
    const y1 = Math.min(height, Math.floor(lower.y - 1));
    if (x1 - x0 < 8) return false;
    for (let y = y0; y < y1; y++) {
      let dark = 0;
      for (let x = x0; x < x1; x++) {
        const p = (y * width + x) * 4;
        if (rgba[p] + rgba[p + 1] + rgba[p + 2] < 240 && rgba[p + 3] > 127) dark++;
      }
      if (dark / (x1 - x0) >= 0.65) return true;
    }
    return false;
  };
}

/** Crop refinement preserves discovery geometry and falls back on crop failure. */
export async function refineDialogueBoxes(
  boxes: readonly Box[],
  recognizeCrop: (box: Box) => Promise<{ text: string; confidence: number }>,
  minConfidence: number,
  acceptFallback: (box: Box) => boolean = () => true,
): Promise<Box[]> {
  const out: Box[] = [];
  for (const box of boxes) {
    let text = box.text ?? '';
    try {
      const result = await recognizeCrop(box);
      if (result.text.trim() && result.confidence >= minConfidence) text = joinOcrLines(result.text);
      else if (!acceptFallback(box)) continue;
    } catch { /* crop OCR is best effort; don't discard discovered dialogue */ }
    out.push({ ...box, text });
  }
  return out;
}
