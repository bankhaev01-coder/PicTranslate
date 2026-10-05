import type { Box } from '../types';
import { refineDialogueBoxes } from './dialogueGroups';

/** Narrow crop OCR to a supported dominant script; never download a new language.
 * The user's language list remains unchanged. Mixed-script pages stay mixed.
 */
export function refinementLanguages(langs: readonly string[], text: string, sourceLang: string): string[] {
  if (sourceLang === 'en' && langs.includes('eng')) return ['eng'];
  if (sourceLang === 'ru' && langs.includes('rus')) return ['rus'];
  if (sourceLang !== 'auto') return [...langs];
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 20) return [...langs];
  const latin = letters.filter(c => /\p{Script=Latin}/u.test(c)).length;
  const cyrillic = letters.filter(c => /\p{Script=Cyrillic}/u.test(c)).length;
  const japanese = letters.filter(c => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(c)).length;
  if (japanese / letters.length >= 0.7) {
    const selected = langs.filter(lang => lang === 'jpn' || lang === 'jpn_vert');
    if (selected.length) return selected;
  }
  if (latin / letters.length >= 0.9 && langs.includes('eng')) return ['eng'];
  if (cyrillic / letters.length >= 0.9 && langs.includes('rus')) return ['rus'];
  return [...langs];
}

/** Applied after grouping, never to individual lines such as I or A in a sentence.
 * Ambiguous tiny fragments are suppressed, not asserted to be non-text universally.
 */
export function readableDialogue(text: string): boolean {
  const cleaned = text.trim();
  const letters = cleaned.match(/\p{L}/gu) ?? [];
  if (letters.length >= 3) return true;
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(cleaned)) return true;
  if (/^(?:I|A|NO|OH|AH|OK|HI|IS|IT|ME|WE|HE|US|Я|А|О|ДА)[!?.,…]*$/u.test(cleaned)) return true;
  return /^(?:[!?…]+|\d{2,}[!?.,…]*)$/u.test(cleaned);
}

/** Evidence for a white source-text mask, not a speech-balloon boundary detector.
 * Sample a 4px ring outside the text bbox, in original image coordinates.
 */
export function lightTextBackdrop(rgba: Uint8ClampedArray, width: number, height: number): (box: Box) => boolean {
  return box => {
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite)
        || box.width <= 0 || box.height <= 0 || rgba.length < width * height * 4) return false;
    const x0 = Math.max(0, Math.floor(box.x - 4)), x1 = Math.min(width, Math.ceil(box.x + box.width + 4));
    const y0 = Math.max(0, Math.floor(box.y - 4)), y1 = Math.min(height, Math.ceil(box.y + box.height + 4));
    let light = 0, total = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) continue;
      const p = (y * width + x) * 4; total++;
      if (rgba[p] > 220 && rgba[p + 1] > 220 && rgba[p + 2] > 220 && rgba[p + 3] > 127) light++;
    }
    return total > 0 && light / total >= 0.85;
  };
}

const FUNCTION_WORDS = new Set('ABOUT AFTER BEFORE UNDER OVER WITH FROM INTO SOME MANY MUCH MORE MOST YOUR THIS THAT THEIR THERE WHAT WHEN WHERE WHICH HAVE DOES DONT WILL ONLY VERY'.split(' '));

/** Repair a split only if its complete spelling was read elsewhere on this page.
 * No manga-specific word list, model or blind removal of spaces. Both fragments
 * must be >=4 letters; function-word phrases and absent evidence are untouched.
 */
export function repairPageWordSplits(boxes: readonly Box[]): Box[] {
  const vocabulary = new Set(boxes.flatMap(box => (box.text ?? '').match(/[A-Za-z]{8,}/g) ?? []).map(word => word.toUpperCase()));
  return boxes.map(box => {
    let text = box.text ?? '';
    const re = /\b([A-Za-z]{4,})[ \t]+([A-Za-z]{4,})\b/g;
    const edits: Array<{ start: number; end: number; word: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const [fragment, left, right] = match;
      const joined = left + right;
      if (!FUNCTION_WORDS.has(left.toUpperCase()) && !FUNCTION_WORDS.has(right.toUpperCase()) && vocabulary.has(joined.toUpperCase())) {
        edits.push({ start: match.index, end: match.index + fragment.length, word: joined });
      } else re.lastIndex = match.index + left.length;
    }
    for (const edit of edits.reverse()) text = text.slice(0, edit.start) + edit.word + text.slice(edit.end);
    return { ...box, text };
  });
}

/** Shared page policy: a bounded number of real crops, safe fallback, noise
 * suppression, page-backed word repair, and masks only on light backgrounds. */
export async function refinePageDialogues(
  grouped: readonly Box[],
  recognizeCrop: (box: Box) => Promise<{ text: string; confidence: number }>,
  minConfidence: number,
  lightBackdrop: (box: Box) => boolean,
): Promise<Box[]> {
  const refined = await refineDialogueBoxes(grouped.slice(0, 16), recognizeCrop, minConfidence,
    box => readableDialogue(box.text ?? '') && lightBackdrop(box));
  return repairPageWordSplits([...refined, ...grouped.slice(16)]
    .filter(box => readableDialogue(box.text ?? '')))
    .map(box => ({ ...box, maskSource: lightBackdrop(box) }));
}
