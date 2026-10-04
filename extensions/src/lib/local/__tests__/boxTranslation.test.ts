import { describe, expect, it, vi } from 'vitest';
import { dialogueTranslationText, translateDialogueBoxes } from '../boxTranslation';
import type { Box } from '../../types';
const box = (text: string): Box => ({ x: 1, y: 2, width: 100, height: 70, text });

describe('dialogue box translation', () => {
  it('translates the whole grouped bubble once and assembles the panel from the same result', async () => {
    const translate = vi.fn().mockResolvedValueOnce('Способность видеть ложь?').mockResolvedValueOnce('Да.');
    const results = await translateDialogueBoxes([box('THE ABILITY TO SEE THROUGH FALSEHOODS?'), box('YES.')], translate);
    expect(translate.mock.calls).toEqual([['THE ABILITY TO SEE THROUGH FALSEHOODS?'], ['YES.']]);
    expect(results[0]).toEqual({ ...box('THE ABILITY TO SEE THROUGH FALSEHOODS?'), translation: 'Способность видеть ложь?' });
    expect(dialogueTranslationText(results)).toBe('Способность видеть ложь?\nДа.');
  });
  it('never substitutes the whole-page translation on a partial or empty failure', async () => {
    const translate = vi.fn().mockRejectedValueOnce(new Error('429')).mockResolvedValueOnce('  ').mockResolvedValueOnce('Готово');
    const results = await translateDialogueBoxes([box('FIRST'), box('SECOND'), box('THIRD')], translate);
    expect(results.map(b => b.translation)).toEqual(['', '', 'Готово']);
    expect(dialogueTranslationText(results)).toBe('Готово');
    expect(results[0].text).toBe('FIRST');
  });
  it('does not translate blank boxes and handles empty input', async () => {
    const translate = vi.fn();
    expect(await translateDialogueBoxes([box('   ')], translate)).toEqual([]);
    expect(await translateDialogueBoxes([], translate)).toEqual([]);
    expect(translate).not.toHaveBeenCalled();
  });
});
