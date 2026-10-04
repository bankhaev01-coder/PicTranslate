import type { Box } from '../types';

/** Sequential, bounded-memory translation: a crop failure never receives the
 * translation of the entire page. Untranslated boxes keep their source visible.
 */
export async function translateDialogueBoxes(
  boxes: readonly Box[], translate: (text: string) => Promise<string>,
): Promise<Box[]> {
  const results: Box[] = [];
  for (const box of boxes) {
    const text = (box.text ?? '').trim();
    if (!text) continue;
    let translation = '';
    try { translation = (await translate(text)).trim(); } catch { /* retry via the page UI */ }
    results.push({ ...box, translation });
  }
  return results;
}

export function dialogueTranslationText(boxes: readonly Box[]): string {
  return boxes.map(box => (box.translation ?? '').trim()).filter(Boolean).join('\n');
}
