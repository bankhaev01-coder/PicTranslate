import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../lib/constants';
const mocks = vi.hoisted(() => ({ listener: vi.fn(), vendor: vi.fn(), native: vi.fn(),
  get: vi.fn(), set: vi.fn(), translate: vi.fn(), ensurePair: vi.fn(), localTranslate: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { onMessage: { addListener: mocks.listener } } } }));
vi.mock('@/lib/i18n', () => ({ default: { t: (key: string) => key }, initI18n: async () => undefined }));
vi.mock('@/lib/local/vendor', () => ({ getVendorManifest: mocks.vendor }));
vi.mock('@/lib/local/localCache', async importOriginal => ({ ...(await importOriginal<object>()),
  sha256Hex: async () => 'image-hash', localCacheGet: mocks.get, localCacheSet: mocks.set }));
vi.mock('@/lib/native/nativeClient', () => ({ sendNativeMessage: mocks.native }));
vi.mock('@/lib/local/externalMt', () => ({ translateLongText: mocks.translate }));
vi.mock('@/lib/local/mtClient', () => ({ MtClient: class { ensurePair = mocks.ensurePair; translate = mocks.localTranslate; } }));
import '../main';
import type { LocalEngineSettings, TranslateResult } from '../../../lib/types';
const settings: LocalEngineSettings = { ...DEFAULT_SETTINGS, useNativeHost: true,
  externalMt: 'google', externalMtPriority: 'prefer', sourceLang: 'en', ocrLangs: ['eng'] };
const native = { ok: true, source_text: 'THE ABILITY\nTO SEE THROUGH FALSEHOODS?', boxes: [
  { x: 10, y: 10, width: 150, height: 12, text: 'THE ABILITY' },
  { x: 10, y: 27, width: 150, height: 12, text: 'TO SEE THROUGH FALSEHOODS?' },
] };
const listener = mocks.listener.mock.calls[0][0] as (msg: unknown, sender: unknown, reply: (value: TranslateResult) => void) => boolean;
const dispatch = () => new Promise<TranslateResult>(resolve => listener({ type: 'TRANSLATE_LOCAL', target: 'offscreen',
  settings, dataUrl: 'data:image/png;base64,AA==', regionOnly: false }, {}, resolve));
beforeEach(() => {
  vi.clearAllMocks(); mocks.vendor.mockResolvedValue(null); mocks.native.mockResolvedValue(native);
  mocks.get.mockResolvedValue(null); mocks.translate.mockResolvedValue({ translation: 'Способность видеть ложь?', detected: 'en' });
});

describe('offscreen dialogue composition', () => {
  it('groups native OCR lines and translates the entire dialogue once without a local NMT pack', async () => {
    const result = await dispatch();
    expect(result.error).toBeUndefined();
    expect(result.source_text).toBe('THE ABILITY TO SEE THROUGH FALSEHOODS?');
    expect(result.boxes).toEqual([{ x: 10, y: 10, width: 150, height: 29,
      text: 'THE ABILITY TO SEE THROUGH FALSEHOODS?', translation: 'Способность видеть ложь?' }]);
    expect(result.translation).toBe('Способность видеть ложь?');
    expect(mocks.translate).toHaveBeenCalledExactlyOnceWith('THE ABILITY TO SEE THROUGH FALSEHOODS?', 'en', 'ru', expect.any(Object));
    expect(mocks.ensurePair).not.toHaveBeenCalled(); expect(mocks.localTranslate).not.toHaveBeenCalled();
  });
  it('passes the OCR confidence threshold to the native host', async () => {
    await dispatch();
    expect(mocks.native).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ocr', min_confidence: settings.ocrMinConfidence ?? 40 }));
  });
  it('keeps one failed dialogue untranslated rather than copying another dialogue into it', async () => {
    mocks.native.mockResolvedValue({ ...native, boxes: [...native.boxes,
      { x: 300, y: 100, width: 100, height: 20, text: 'ANOTHER BUBBLE' }] });
    mocks.translate.mockRejectedValueOnce(new Error('429')).mockResolvedValueOnce({ translation: 'Другая реплика' });
    const result = await dispatch();
    expect(result.boxes?.map(b => b.translation)).toEqual(['', 'Другая реплика']);
    expect(result.translation).toBe('Другая реплика');
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it('returns an error if all dialogue translations fail and does not cache success', async () => {
    mocks.translate.mockRejectedValue(new Error('provider down'));
    const result = await dispatch(); expect(result.error).toContain('local.errExternalFailed');
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it('serializes local requests so shared OCR and MT workers cannot overlap', async () => {
    let release!: (value: typeof native) => void;
    mocks.native.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = dispatch();
    await vi.waitFor(() => expect(mocks.native).toHaveBeenCalledOnce());
    const second = dispatch(); await Promise.resolve(); await Promise.resolve();
    expect(mocks.native).toHaveBeenCalledOnce(); release(native);
    const results = await Promise.all([first, second]);
    expect(mocks.native).toHaveBeenCalledTimes(2); expect(results.every(r => !r.error)).toBe(true);
  });
});
