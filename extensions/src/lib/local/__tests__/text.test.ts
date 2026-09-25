import { describe, expect, it } from 'vitest';
import { chunkText, isMostlyCyrillic, pickPair } from '../text';

const AVAILABLE = ['en-ru', 'ru-en'];
const DOWNLOADED = ['en-ru'];

describe('isMostlyCyrillic', () => {
  it('detects russian', () => expect(isMostlyCyrillic('Привет, мир!')).toBe(true));
  it('detects english', () => expect(isMostlyCyrillic('Hello, world!')).toBe(false));
  it('ignores very short text', () => expect(isMostlyCyrillic('ab')).toBe(false));
  it('handles mixed text', () => expect(isMostlyCyrillic('это текст на русском языке для теста')).toBe(true));
});

describe('pickPair', () => {
  const base = { preferred: 'en-ru', available: AVAILABLE, targetLang: 'ru', text: 'Hello' };

  it('explicit direction uses matching pair', () => {
    expect(pickPair({ ...base, sourceLang: 'en' }, DOWNLOADED)).toEqual({
      pair: 'en-ru',
      passthrough: false,
    });
  });

  it('same source and target → passthrough', () => {
    expect(pickPair({ ...base, sourceLang: 'ru', text: 'привет' }, DOWNLOADED).passthrough).toBe(true);
  });

  it('auto + latin text + ru target → en-ru', () => {
    expect(pickPair({ ...base, sourceLang: 'auto', text: 'Hello this is a test image' }, DOWNLOADED).pair).toBe('en-ru');
  });

  it('auto + cyrillic text + ru target → passthrough', () => {
    expect(pickPair({ ...base, sourceLang: 'auto', text: 'Это русский текст на картинке' }, DOWNLOADED).passthrough).toBe(true);
  });

  it('auto + cyrillic text + en target → ru-en (when downloaded)', () => {
    expect(
      pickPair(
        { ...base, targetLang: 'en', sourceLang: 'auto', text: 'Привет как дела' },
        ['en-ru', 'ru-en'],
      ).pair,
    ).toBe('ru-en');
  });

  it('auto + cyrillic text + en target but not downloaded → missingPair', () => {
    const r = pickPair({ ...base, targetLang: 'en', sourceLang: 'auto', text: 'Привет как дела' }, DOWNLOADED);
    expect(r.pair).toBeUndefined();
    expect(r.missingPair).toBe('ru-en');
  });

  it('auto + latin text + en target → passthrough', () => {
    expect(pickPair({ ...base, targetLang: 'en', sourceLang: 'auto', text: 'Plain english picture' }, DOWNLOADED).passthrough).toBe(true);
  });

  it('model not downloaded → missingPair', () => {
    const r = pickPair({ ...base, sourceLang: 'auto', text: 'Hello there my friend image' }, []);
    expect(r.pair).toBeUndefined();
    expect(r.missingPair).toBe('en-ru');
  });

  it('unsupported target language → missingPair with exact direction', () => {
    const r = pickPair({ ...base, targetLang: 'de', sourceLang: 'auto', text: 'Hello world this is fine' }, AVAILABLE);
    expect(r.missingPair).toBe('en-de');
  });
});

describe('chunkText', () => {
  it('keeps short text whole', () => {
    expect(chunkText('one line only')).toEqual(['one line only']);
  });

  it('splits long text under the limit', () => {
    const long = Array.from(
      { length: 30 },
      (_, i) => `Sentence number ${i} about something interesting.`,
    ).join(' ');
    const chunks = chunkText(long, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(120);
    expect(chunks.join(' ')).toContain('Sentence number 29');
  });

  it('hard-splits pathological single lines', () => {
    const huge = 'word '.repeat(400);
    const chunks = chunkText(huge, 200);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
    expect(chunks.join('')).toContain('word');
  });

  it('preserves newlines between short lines', () => {
    const chunks = chunkText('line one\nline two', 400);
    expect(chunks).toEqual(['line one\nline two']);
  });

  it('empty text → no chunks', () => {
    expect(chunkText('')).toEqual([]);
  });
});
