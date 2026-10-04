import { describe, expect, it, vi } from 'vitest';
import { lightTextBackdrop, readableDialogue, refinementLanguages, repairPageWordSplits, refinePageDialogues } from '../pageOcr';
import { refineDialogueBoxes } from '../dialogueGroups';
import type { Box } from '../../types';
const box = (text: string): Box => ({ x: 5, y: 5, width: 10, height: 10, text });

describe('page OCR refinement policy', () => {
  it('narrows English-dominant crop OCR without changing user settings or downloading languages', () => {
    const langs = ['eng', 'rus'];
    expect(refinementLanguages(langs, "WHY'S A GUY LIKE THAT WORKING UNDER SOME WOMAN?", 'auto')).toEqual(['eng']);
    expect(langs).toEqual(['eng', 'rus']);
    expect(refinementLanguages(['rus'], 'This is a sufficiently long English sentence', 'en')).toEqual(['rus']);
  });
  it('keeps mixed-script and short samples mixed and respects an explicit supported source language', () => {
    expect(refinementLanguages(['eng', 'rus'], 'Hello мир привет world русский language', 'auto')).toEqual(['eng', 'rus']);
    expect(refinementLanguages(['eng', 'rus'], 'THEN?', 'auto')).toEqual(['eng', 'rus']);
    expect(refinementLanguages(['eng', 'rus'], 'Hello world', 'ru')).toEqual(['rus']);
  });
  it('narrows Cyrillic-dominant crops to Russian', () => {
    expect(refinementLanguages(['eng', 'rus'], 'Это достаточно длинная фраза на русском языке.', 'auto')).toEqual(['rus']);
  });
  it('suppresses tiny artwork fragments after grouping while keeping meaningful short dialogue', () => {
    for (const text of ['pA', 'EM', '(1°', 'у,', 'a', 'J', 'is', '&']) expect(readableDialogue(text)).toBe(false);
    for (const text of ['THEN?', 'I', 'A', 'NO!', 'OK', 'Я', 'ДА!', '?!', '42', 'え', 'I AM HERE']) expect(readableDialogue(text)).toBe(true);
  });
  it('uses a light surrounding ring, not ink inside the text rectangle, to permit a source mask', () => {
    const rgba = new Uint8ClampedArray(20 * 20 * 4).fill(255);
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) { const p = (y * 20 + x) * 4; rgba[p] = rgba[p+1] = rgba[p+2] = 0; }
    const light = lightTextBackdrop(rgba, 20, 20);
    expect(light(box('TEXT'))).toBe(true);
    rgba.fill(0); expect(light(box('TEXT'))).toBe(false);
    expect(light({ ...box('TEXT'), x: NaN })).toBe(false);
    expect(light({ ...box('TEXT'), x: 100 })).toBe(false);
  });
  it('drops an unconfirmed dark-background candidate without discarding a light-background fallback', async () => {
    const crop = vi.fn().mockResolvedValue({ text: '', confidence: 0 });
    const input = [box('E SPAN,'), box('REAL DIALOGUE')];
    expect(await refineDialogueBoxes(input, crop, 40, b => b.text === 'REAL DIALOGUE')).toEqual([input[1]]);
  });
  it('preserves discovery on a transient crop exception even under the strict fallback policy', async () => {
    const input = [box('REAL DIALOGUE')];
    expect(await refineDialogueBoxes(input, async () => { throw new Error('worker failure'); }, 40, () => false)).toEqual(input);
  });
});

describe('page-backed word split repair', () => {
  it('repairs a broken word only when the full spelling exists elsewhere on the page', () => {
    const input = [box('BECOME MY SUBORDINATE.'), box('YOUR SUBOR DINATE')];
    expect(repairPageWordSplits(input).map(b => b.text)).toEqual(['BECOME MY SUBORDINATE.', 'YOUR SUBORDINATE']);
    expect(input[1].text).toBe('YOUR SUBOR DINATE');
  });
  it('does not invent a spelling or join normal function-word phrases', () => {
    expect(repairPageWordSplits([box('YOUR SUBOR DINATE')])[0].text).toBe('YOUR SUBOR DINATE');
    expect(repairPageWordSplits([box('SOMETHING'), box('SOME THING')])[1].text).toBe('SOME THING');
    expect(repairPageWordSplits([box('THERAPIST'), box('THE RAPIST')])[1].text).toBe('THE RAPIST');
  });
  it('preserves punctuation and can repair more than one evidenced split', () => {
    const input = [box('SUBORDINATE COMPOSITION'), box('A subor dinate, then compo sition!')];
    expect(repairPageWordSplits(input)[1].text).toBe('A subordinate, then composition!');
  });
});

// Recorded real Tesseract results from the user's clean page. The image itself
// is not committed; this regression replays the OCR boundary, not a live engine.
import fixture from './fixtures/manga-page-ocr.json';
describe('recorded real-page regression', () => {
  it('keeps five dialogues, restores the negation and repairs the evidenced split without artwork labels', async () => {
    const boxes = fixture.map(record => record.box);
    const crop = vi.fn(async (b: Box) => fixture.find(record => record.box.x === b.x && record.box.y === b.y)!.crop);
    const light = (b: Box) => fixture.find(record => record.box.x === b.x && record.box.y === b.y)!.lightBackdrop;
    const result = await refinePageDialogues(boxes, crop, 40, light);
    expect(result).toHaveLength(5);
    expect(result.map(b => b.x)).toEqual([911, 789, 836, 337, 213]);
    expect(result[2].text).toContain("I DON'T CARE");
    expect(result[3].text).toBe('BECOME MY SUBORDINATE.');
    expect(result[4].text).toBe('YOUR SUBORDINATE');
    expect(result.every(b => b.maskSource)).toBe(true);
    expect(crop).toHaveBeenCalledTimes(13);
  });
  it('bounds crop work at sixteen and keeps later readable dialogue instead of silently dropping it', async () => {
    const boxes = Array.from({length: 18}, (_,i) => ({ ...box('LATER DIALOGUE'), x: i * 20 }));
    const crop = vi.fn().mockResolvedValue({ text: 'READABLE DIALOGUE', confidence: 90 });
    const result = await refinePageDialogues(boxes, crop, 40, () => true);
    expect(crop).toHaveBeenCalledTimes(16);
    expect(result).toHaveLength(18);
    expect(result[17].text).toBe('LATER DIALOGUE');
  });
});
