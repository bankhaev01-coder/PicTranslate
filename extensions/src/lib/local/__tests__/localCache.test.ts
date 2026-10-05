import { describe, expect, it } from 'vitest';
import { buildLocalCacheKey, type LocalCacheKeyInput } from '../localCache';

const base: LocalCacheKeyInput = {
  imageHash: 'abc123',
  regionOnly: true,
  sourceLang: 'auto',
  targetLang: 'ru',
  ocrLangs: ['eng'],
  ocrQuality: 'balanced',
  japaneseOcrLayout: 'auto',
  ocrMinConfidence: 40,
  useNativeHost: false,
  cloudOcr: false,
  cloudTranslate: false,
  externalMt: 'off',
  externalMtPriority: 'prefer',
};

const key = (patch: Partial<LocalCacheKeyInput> = {}) => buildLocalCacheKey({ ...base, ...patch });

describe('buildLocalCacheKey', () => {
  it('keeps the same key for identical settings', () => {
    expect(key().cacheId).toBe(key().cacheId);
  });

  it('separates region crop from the full page scan', () => {
    expect(key().scope).toBe('reg');
    expect(key({ regionOnly: false }).scope).toBe('full');
  });

  it('changes the key when the external MT provider changes', () => {
    const google = key({ externalMt: 'google' }).cacheId;
    const yandexCloud = key({ externalMt: 'yandex-cloud' }).cacheId;
    const yandex = key({ externalMt: 'yandex' }).cacheId;
    expect(new Set([google, yandexCloud, yandex]).size).toBe(3);
  });

  it('changes the key when the provider priority changes', () => {
    expect(key({ externalMt: 'google', externalMtPriority: 'prefer' }).cacheId).not.toBe(
      key({ externalMt: 'google', externalMtPriority: 'fallback' }).cacheId,
    );
  });

  it('changes the key when OCR settings change', () => {
    expect(key({ ocrQuality: 'fast' }).cacheId).not.toBe(key({ ocrQuality: 'best' }).cacheId);
    expect(key({ ocrMinConfidence: 20 }).cacheId).not.toBe(key({ ocrMinConfidence: 60 }).cacheId);
    expect(key({ useNativeHost: true }).cacheId).not.toBe(key().cacheId);
    expect(key({ japaneseOcrLayout: 'horizontal' }).cacheId).not.toBe(key({ japaneseOcrLayout: 'vertical' }).cacheId);
  });

  it('marks cloud OCR and cloud translation distinctly', () => {
    const cloud = key({ cloudOcr: true }).cacheId;
    const cloudTr = key({ cloudOcr: true, cloudTranslate: true }).cacheId;
    expect(cloud).toContain('cloud');
    expect(cloudTr).toContain('cloudTr');
    expect(cloud).not.toBe(cloudTr);
  });

  it('ignores cloud tags for the full page scan (cloud OCR is crop-only)', () => {
    expect(key({ regionOnly: false, cloudOcr: true }).cacheId).not.toContain('cloud');
  });

  it('includes languages and the image hash', () => {
    const id = key({ ocrLangs: ['eng', 'rus'], sourceLang: 'en', targetLang: 'ru' }).cacheId;
    expect(id.startsWith('ru:en:eng+rus:')).toBe(true);
    expect(id.endsWith(':abc123')).toBe(true);
    expect(id).not.toBe(key({ imageHash: 'def456' }).cacheId);
  });

  it('keeps distinct OCR language order', () => {
    expect(key({ ocrLangs: ['eng', 'rus'] }).cacheId).not.toBe(key({ ocrLangs: ['rus', 'eng'] }).cacheId);
  });
});
