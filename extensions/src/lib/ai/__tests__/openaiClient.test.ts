import { afterEach, describe, expect, it, vi } from 'vitest';
import { translateWithOpenAI } from '../openaiClient';
import { hasDirectAiKey, translateWithAI } from '../engine';
import type { Settings } from '../../types';
import { DEFAULT_SETTINGS } from '../../constants';

afterEach(() => {
  vi.unstubAllGlobals();
});

function openAiBody(content: string) {
  return { choices: [{ message: { content } }] };
}

function stubFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })),
  );
}

const baseSettings: Settings = { ...DEFAULT_SETTINGS, targetLang: 'ru', sourceLang: 'auto' };

describe('translateWithOpenAI', () => {
  it('fails fast when no key and anonymous is not allowed', async () => {
    const res = await translateWithOpenAI('data:image/png;base64,AAA', { targetLang: 'ru' });
    expect(res.error).toMatch(/API key/i);
    expect(res.model).toBe('openai:gpt-4o');
  });

  it('supports anonymous providers (Pollinations) via url override', async () => {
    stubFetch(openAiBody('{"source_text":"Hello","translation":"Привет","detected_language":"en"}'));
    const res = await translateWithOpenAI('data:image/png;base64,AAA', {
      url: 'https://text.pollinations.ai/openai',
      model: 'openai',
      providerLabel: 'pollinations',
      allowAnonymous: true,
      targetLang: 'ru',
    });
    expect(res.error).toBeUndefined();
    expect(res.model).toBe('pollinations:openai');
    expect(res.translation).toBe('Привет');
    expect(fetch).toHaveBeenCalledWith('https://text.pollinations.ai/openai', expect.anything());
  });

  it('annotates rate limits', async () => {
    stubFetch({ error: { message: 'slow down' } }, 429);
    const res = await translateWithOpenAI('data:image/png;base64,AAA', {
      apiKey: 'sk-x',
      targetLang: 'ru',
    });
    expect(res.error).toMatch(/rate limit/);
  });
});

describe('pollinations routing in engine', () => {
  it('requires a free API key for pollinations (vision is key-only)', () => {
    expect(hasDirectAiKey({ ...baseSettings, model: 'pollinations' })).toBe(false);
    expect(
      hasDirectAiKey({ ...baseSettings, model: 'pollinations', pollinationsApiKey: 'pk_x' }),
    ).toBe(true);
  });

  it('routes pollinations to the gen OpenAI-compatible endpoint', async () => {
    stubFetch(openAiBody('{"source_text":"Hi","translation":"Привет"}'));
    const res = await translateWithAI('data:image/png;base64,AAA', {
      ...baseSettings,
      model: 'pollinations',
      pollinationsModel: 'openai',
      pollinationsApiKey: 'pk_x',
    });
    expect(res.model).toBe('pollinations:openai');
    expect(res.translation).toBe('Привет');
    expect(fetch).toHaveBeenCalledWith(
      'https://gen.pollinations.ai/v1/chat/completions',
      expect.anything(),
    );
  });

  it('maps 401 to a readable authentication error', async () => {
    stubFetch({ error: { message: 'A valid API key is required' } }, 401);
    const res = await translateWithAI('data:image/png;base64,AAA', {
      ...baseSettings,
      model: 'pollinations',
      pollinationsApiKey: 'pk_bad',
    });
    expect(res.error).toMatch(/authentication failed/);
  });
});

describe('openrouter routing in engine', () => {
  it('needs a key, and the default model is the free router', () => {
    expect(hasDirectAiKey({ ...baseSettings, model: 'openrouter' })).toBe(false);
    expect(
      hasDirectAiKey({ ...baseSettings, model: 'openrouter', openrouterApiKey: 'sk-or-x' }),
    ).toBe(true);
    expect(baseSettings.openrouterModel).toBe('openrouter/free');
  });

  it('sends images to the OpenAI-compatible endpoint with the free router', async () => {
    stubFetch(openAiBody('{"source_text":"Hi","translation":"Привет"}'));
    const res = await translateWithAI('data:image/png;base64,AAA', {
      ...baseSettings,
      model: 'openrouter',
      openrouterApiKey: 'sk-or-x',
    });
    expect(res.model).toBe('openrouter:openrouter/free');
    expect(res.translation).toBe('Привет');
    expect(fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ 'HTTP-Referer': expect.any(String) }),
      }),
    );
  });
});
