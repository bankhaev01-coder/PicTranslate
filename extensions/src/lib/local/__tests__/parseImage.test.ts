import { afterEach, describe, expect, it, vi } from 'vitest';
import { PARSE_IMAGE_URL, parseImageOcr, parseParseImageJson, toCloudLang } from '../parseImage';

describe('toCloudLang', () => {
  it('maps our BCP-47 codes to backenster xx_XX', () => {
    expect(toCloudLang('en')).toBe('en_US');
    expect(toCloudLang('ru')).toBe('ru_RU');
    expect(toCloudLang('ja')).toBe('ja_JP');
    expect(toCloudLang('zh')).toBe('zh_CN');
    expect(toCloudLang('ko')).toBe('ko_KR');
    expect(toCloudLang('uk')).toBe('uk_UA');
  });

  it('passes through already valid xx_XX codes', () => {
    expect(toCloudLang('ru_RU')).toBe('ru_RU');
    expect(toCloudLang('en_US')).toBe('en_US');
  });

  it('falls back to en_US for auto and unknown codes (server rejects both)', () => {
    expect(toCloudLang('auto')).toBe('en_US');
    expect(toCloudLang('xx')).toBe('en_US');
  });
});

describe('parseParseImageJson', () => {
  it('parses a real parseImage response (fixture from smoke test)', () => {
    const r = parseParseImageJson({
      sourceData: ['THE', 'SO-CALLED LOOK.', 'FINALLY'],
      translatedData: ['-', 'ТАК НАЗЫВАЕМЫЙ ВЗГЛЯД.', 'ОКОНЧАТЕЛЬНО'],
      err: null,
      result: 'staticImageParser/abc.png',
    });
    expect(r.sourceText).toBe('THE SO-CALLED LOOK. FINALLY');
    expect(r.translatedText).toBe('- ТАК НАЗЫВАЕМЫЙ ВЗГЛЯД. ОКОНЧАТЕЛЬНО');
    expect(r.lineCount).toBe(3);
  });

  it('throws on server err', () => {
    expect(() => parseParseImageJson({ err: 'Bad languages' })).toThrow('Bad languages');
  });

  it('throws when sourceData is empty or missing', () => {
    expect(() => parseParseImageJson({ sourceData: [], translatedData: [] })).toThrow('empty sourceData');
    expect(() => parseParseImageJson({})).toThrow('empty sourceData');
    expect(() => parseParseImageJson(null)).toThrow('empty sourceData');
  });

  it('tolerates missing translatedData and non-string entries', () => {
    const r = parseParseImageJson({ sourceData: ['ok', 42, null] });
    expect(r.sourceText).toBe('ok');
    expect(r.translatedText).toBe('');
    expect(r.lineCount).toBe(3);
  });
});

describe('parseImageOcr', () => {
  afterEach(() => vi.unstubAllGlobals());

  const okJson = { sourceData: ['HELLO'], translatedData: ['ПРИВЕТ'], err: null };

  /** fetch-мок: первый вызов — чтение data URL (blob), второй — POST на parseImage. */
  function stubFetchs(second: { ok: boolean; status: number; json: unknown }) {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) {
          return { blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) } as Response;
        }
        void init;
        return { ok: second.ok, status: second.status, json: async () => second.json } as Response;
      }),
    );
    return () => calls;
  }

  it('POSTs multipart form to parseImage with xx_XX languages', async () => {
    const posts: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init) {
          posts.push({ url: String(input), init });
          return { ok: true, status: 200, json: async () => okJson } as Response;
        }
        return { blob: async () => new Blob([new Uint8Array([1])], { type: 'image/png' }) } as Response;
      }),
    );

    const r = await parseImageOcr('data:image/png;base64,AAAA', 'en', 'ru');
    expect(r.sourceText).toBe('HELLO');
    expect(r.translatedText).toBe('ПРИВЕТ');

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(PARSE_IMAGE_URL);
    expect(posts[0].init?.method).toBe('POST');
    const headers = posts[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Bearer /);
    const form = posts[0].init?.body as FormData;
    expect(form.get('from')).toBe('en_US');
    expect(form.get('to')).toBe('ru_RU');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('throws on HTTP error', async () => {
    stubFetchs({ ok: false, status: 503, json: {} });
    await expect(parseImageOcr('data:image/png;base64,AAAA', 'en', 'ru')).rejects.toThrow('HTTP 503');
  });

  it('propagates server err payload', async () => {
    stubFetchs({ ok: true, status: 200, json: { err: 'Bad languages' } });
    await expect(parseImageOcr('data:image/png;base64,AAAA', 'auto', 'ru')).rejects.toThrow('Bad languages');
  });

  it('rejects when the image fetch fails (offline fallback trigger)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    await expect(parseImageOcr('data:image/png;base64,AAAA', 'en', 'ru')).rejects.toThrow('network down');
  });
});