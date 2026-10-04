// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentMsg, Msg, PageImage, TranslateResult } from '../../lib/types';
const mocks = vi.hoisted(() => ({ listen: vi.fn(), send: vi.fn(), status: vi.fn(), snapshot: vi.fn(), hidden: vi.fn(),
  callbacks: [] as Array<{ onTranslate: (images: PageImage[]) => void }> }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { onMessage: { addListener: mocks.listen }, sendMessage: mocks.send } } }));
vi.mock('wxt/utils/define-unlisted-script', () => ({ defineUnlistedScript: (main: unknown) => main }));
vi.mock('@/lib/storage', async () => ({ getSettings: async () => (await import('../../lib/constants')).DEFAULT_SETTINGS }));
vi.mock('@/lib/i18n', () => ({ initI18nFromSettings: async () => undefined }));
vi.mock('@/lib/scanner', () => ({ scanImages: () => [{ id: 'img', src: 'source.png', width: 100, height: 100, visible: true }],
  fetchImageBlob: async () => ({ ok: true, blob: new Blob(['image'], { type: 'image/png' }) }), cropRegion: vi.fn() }));
vi.mock('@/lib/overlay', () => ({ OverlayUI: class {
  constructor(cb: { onTranslate: (images: PageImage[]) => void }) { mocks.callbacks.push(cb); }
  setImages() {} destroy() {} hidePanel() {} setProgress() {}
  setStatus = mocks.status; showViewportResult = mocks.snapshot; setCaptureHidden = mocks.hidden;
} }));
vi.mock('@/lib/viewportTranslation', async importOriginal => ({ ...(await importOriginal<object>()),
  dataUrlImageSize: async () => ({ width: 1000, height: 600 }) }));
import entry from '../injected';
const result: TranslateResult = { source_text: 'HELLO', translation: 'Привет', model: 'test', latency_ms: 1,
  boxes: [{ x: 10, y: 20, width: 100, height: 50, translation: 'Привет' }] };
let listener: (msg: Msg | ContentMsg, sender: unknown, reply: (value: unknown) => void) => boolean;
const dispatch = (msg: ContentMsg) => new Promise<unknown>(resolve => listener(msg, {}, resolve));
beforeEach(() => {
  vi.clearAllMocks(); mocks.callbacks.length = 0; (entry as unknown as () => void)();
  listener = mocks.listen.mock.calls[0][0];
  mocks.send.mockImplementation(async (msg: Msg) => msg.type === 'CAPTURE_VISIBLE' ? { dataUrl: 'data:image/png,test' } : result);
});

describe('injected page translation', () => {
  it('initializes an unscanned page, hides UI for capture and renders viewport boxes on the page', async () => {
    expect(await dispatch({ type: 'TRANSLATE_VIEWPORT' })).toEqual(result);
    expect(mocks.hidden.mock.calls).toEqual([[true], [false]]);
    expect(mocks.snapshot).toHaveBeenCalledOnce();
    expect(mocks.snapshot.mock.calls[0][2]).toBe(result);
    expect(mocks.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'TRANSLATE_DATA_URL', regionOnly: false }));
  });
  it('ignores a full-image result from a previous scan even when image ids are reused', async () => {
    await dispatch({ type: 'SCAN_IMAGES' });
    let release!: (r: TranslateResult) => void;
    mocks.send.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    mocks.callbacks[0].onTranslate([{ id: 'img', src: 'source.png', width: 100, height: 100, visible: true }]);
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    await dispatch({ type: 'SCAN_IMAGES' });
    release(result); await new Promise(resolve => setTimeout(resolve, 5));
    expect(mocks.status.mock.calls.map(call => call[1])).toEqual(['working']);
  });
});
