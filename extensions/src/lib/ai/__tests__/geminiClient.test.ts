import { describe, expect, it } from 'vitest';
import { extractJson, translateWithGemini } from '../geminiClient';

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson('{"source_text":"a","translation":"b"}')).toEqual({
      source_text: 'a',
      translation: 'b',
    });
  });

  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it('strips plain ``` fences', () => {
    expect(extractJson('```\n{"a": 2}\n```')).toEqual({ a: 2 });
  });

  it('recovers JSON embedded in prose', () => {
    expect(extractJson('Here you go: {"a": 3} — hope it helps')).toEqual({ a: 3 });
  });

  it('returns an empty object when there is no JSON at all', () => {
    expect(extractJson('garbage no json here')).toEqual({});
  });

  it('returns an empty object for malformed JSON inside braces', () => {
    expect(extractJson('{"a": }')).toEqual({});
  });
});

describe('translateWithGemini', () => {
  it('fails fast with a helpful message when the key is missing', async () => {
    const res = await translateWithGemini('BASE64', { apiKey: '', targetLang: 'ru' });
    expect(res.error).toMatch(/API key/i);
    expect(res.translation).toBe('');
    expect(res.model).toBe('gemini:gemini-3.8-flash');
    expect(res.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('brings the retired 2.5-flash id up to 3.8-flash', async () => {
    const res = await translateWithGemini('BASE64', {
      apiKey: '',
      targetLang: 'ru',
      model: 'gemini-2.5-flash',
    });
    expect(res.model).toBe('gemini:gemini-3.8-flash');
  });

  it('maps the retired 1.5-flash id to 3.8-flash', async () => {
    const res = await translateWithGemini('BASE64', {
      apiKey: '',
      targetLang: 'ru',
      model: 'gemini-1.5-flash',
    });
    expect(res.model).toBe('gemini:gemini-3.8-flash');
  });

  it('reports the configured model in the result', async () => {
    const res = await translateWithGemini('BASE64', {
      apiKey: '',
      targetLang: 'ru',
      model: 'gemini-2.0-flash',
    });
    expect(res.model).toBe('gemini:gemini-2.0-flash');
  });
});
