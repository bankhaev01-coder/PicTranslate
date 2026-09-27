import { describe, expect, it } from 'vitest';
import {
  buildGtxUrl,
  buildYandexRequest,
  parseGtxResponse,
  parseYandexResponse,
  toGoogleLang,
  toYandexLang,
  translateLongText,
} from '../externalMt';

function gtxBody(translated: string, source: string, detected: string): unknown {
  return [[[translated, source, null, null, 1]], null, detected];
}

function okFetch(body: unknown) {
  return (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
}

describe('toGoogleLang', () => {
  it('passes plain codes through', () => {
    expect(toGoogleLang('ru')).toBe('ru');
    expect(toGoogleLang('en')).toBe('en');
  });
  it('strips region suffix', () => expect(toGoogleLang('en-US')).toBe('en'));
  it('maps zh to zh-CN', () => expect(toGoogleLang('zh')).toBe('zh-CN'));
  it('empty → auto', () => expect(toGoogleLang('')).toBe('auto'));
});

describe('parseGtxResponse', () => {
  it('joins sentence fragments and reads the detected language', () => {
    expect(parseGtxResponse(gtxBody('Привет', 'Hello', 'en'))).toEqual({
      translation: 'Привет',
      sourceLang: 'en',
    });
  });

  it('concatenates multi-sentence responses', () => {
    const body = [
      [
        ['Привет, ', 'Hello, ', null, null, 1],
        ['мир!', 'world!', null, null, 1],
      ],
      null,
      'en',
    ];
    expect(parseGtxResponse(body)).toEqual({ translation: 'Привет, мир!', sourceLang: 'en' });
  });

  it('throws on unexpected shape', () => {
    expect(() => parseGtxResponse({})).toThrow();
  });
});

describe('buildGtxUrl', () => {
  it('uses the gtx client with sl/tl/q params', () => {
    const url = new URL(buildGtxUrl('Hello', 'auto', 'ru'));
    expect(url.origin).toBe('https://translate.googleapis.com');
    expect(url.searchParams.get('client')).toBe('gtx');
    expect(url.searchParams.get('sl')).toBe('auto');
    expect(url.searchParams.get('tl')).toBe('ru');
    expect(url.searchParams.get('q')).toBe('Hello');
  });
});

describe('translateLongText', () => {
  it('translates a single chunk and reports detection', async () => {
    const res = await translateLongText('Hello world', 'auto', 'ru', {
      fetchImpl: okFetch(gtxBody('Привет мир', 'Hello world', 'en')),
    });
    expect(res.translation).toBe('Привет мир');
    expect(res.detected).toBe('en');
  });

  it('splits long text into chunks and joins with newlines', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      seen.push(new URL(String(input)).searchParams.get('q') ?? '');
      return { ok: true, status: 200, json: async () => gtxBody('X', 'Y', 'en') };
    }) as unknown as typeof fetch;
    const res = await translateLongText('word '.repeat(100), 'en', 'ru', { fetchImpl, chunkMaxLen: 50 });
    expect(seen.length).toBeGreaterThan(1);
    expect(res.translation.split('\n').length).toBe(seen.length);
  });

  it('throws a readable error on HTTP failure', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(translateLongText('Hello', 'en', 'ru', { fetchImpl })).rejects.toThrow(/HTTP 500/);
  });
});

describe('toYandexLang', () => {
  it('passes plain codes through', () => expect(toYandexLang('ru')).toBe('ru'));
  it('strips region suffix', () => expect(toYandexLang('en-US')).toBe('en'));
  it('maps iw → he', () => expect(toYandexLang('iw')).toBe('he'));
});

describe('buildYandexRequest', () => {
  it('POSTs form data to tr.json with srv=android and id', () => {
    const { url, body } = buildYandexRequest('Hello', 'auto', 'ru', 'abc-0-0');
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://translate.yandex.net');
    expect(parsed.pathname).toBe('/api/v1/tr.json/translate');
    expect(parsed.searchParams.get('srv')).toBe('android');
    expect(parsed.searchParams.get('id')).toBe('abc-0-0');
    expect(body.get('text')).toBe('Hello');
    expect(body.get('target_lang')).toBe('ru');
    expect(body.get('source_lang')).toBeNull(); // auto не отправляется
  });

  it('includes source_lang when it is known', () => {
    const { body } = buildYandexRequest('Hello', 'en-US', 'ru', 'id1');
    expect(body.get('source_lang')).toBe('en');
  });
});

describe('parseYandexResponse', () => {
  it('joins text parts and reads the detected language', () => {
    expect(parseYandexResponse({ code: 200, lang: 'en-ru', text: ['Привет'] })).toEqual({
      translation: 'Привет',
      sourceLang: 'en',
    });
  });

  it('throws on non-200 service code', () => {
    expect(() => parseYandexResponse({ code: 401, text: [] })).toThrow(/code 401/);
  });

  it('throws on unexpected shape', () => {
    expect(() => parseYandexResponse(null)).toThrow();
  });
});

describe('translateLongText with yandex provider', () => {
  it('dispatches to the Yandex endpoint and parses its response', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(String(input));
      expect(init?.method).toBe('POST');
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 200, lang: 'en-ru', text: ['Привет мир'] }),
      };
    }) as unknown as typeof fetch;

    const res = await translateLongText('Hello world', 'auto', 'ru', {
      provider: 'yandex',
      fetchImpl,
    });
    expect(res.translation).toBe('Привет мир');
    expect(res.detected).toBe('en');
    expect(seen[0]).toContain('translate.yandex.net');
  });

  it('propagates yandex HTTP errors', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 429 })) as unknown as typeof fetch;
    await expect(
      translateLongText('Hello', 'en', 'ru', { provider: 'yandex', fetchImpl }),
    ).rejects.toThrow(/yandex: HTTP 429/);
  });
});
