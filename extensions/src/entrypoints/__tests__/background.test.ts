import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  runtime: {
    id: 'ext-id', getURL: (path: string) => `chrome-extension://ext-id${path}`,
    openOptionsPage: vi.fn(), sendNativeMessage: vi.fn(),
    onInstalled: { addListener: vi.fn() }, onMessage: { addListener: vi.fn() },
  },
  tabs: { sendMessage: vi.fn(), query: vi.fn(), captureVisibleTab: vi.fn() },
  contextMenus: { create: vi.fn(), removeAll: vi.fn(), onClicked: { addListener: vi.fn() } },
  scripting: { executeScript: vi.fn() }, windows: { WINDOW_ID_CURRENT: -2 },
}));
vi.mock('wxt/browser', () => ({ browser: mocks }));
vi.mock('wxt/utils/define-background', () => ({ defineBackground: (main: unknown) => main }));
import entry from '../background';
import type { Msg } from '../../lib/types';
let listener: (msg: Msg, sender: unknown, reply: (value: unknown) => void) => boolean;
beforeEach(() => {
  vi.clearAllMocks(); (entry as unknown as () => void)();
  listener = mocks.runtime.onMessage.addListener.mock.calls[0][0];
  mocks.tabs.sendMessage.mockImplementation(async (_id: number, msg: { type: string }) =>
    msg.type === 'PING' ? { ok: true } : { translation: 'on page' });
});
const dispatch = (msg: Msg, sender: unknown = {}) => new Promise<unknown>(resolve => listener(msg, sender, resolve));

describe('background viewport routing', () => {
  it('routes screenshot translation to the requested content script, not a popup-only result', async () => {
    expect(await dispatch({ type: 'CAPTURE_AND_TRANSLATE', tabId: 42 })).toEqual({ translation: 'on page' });
    expect(mocks.tabs.sendMessage).toHaveBeenLastCalledWith(42, { type: 'TRANSLATE_VIEWPORT' });
    expect(mocks.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });
  it('injects the content script when a page has not been scanned yet', async () => {
    mocks.tabs.sendMessage.mockRejectedValueOnce(new Error('no listener'));
    await dispatch({ type: 'CAPTURE_AND_TRANSLATE', tabId: 42 });
    expect(mocks.scripting.executeScript).toHaveBeenCalledExactlyOnceWith({ target: { tabId: 42 }, files: ['injected.js'] });
    expect(mocks.tabs.sendMessage).toHaveBeenLastCalledWith(42, { type: 'TRANSLATE_VIEWPORT' });
  });
  it('returns an explicit error without a tab', async () => {
    expect(await dispatch({ type: 'CAPTURE_AND_TRANSLATE' })).toHaveProperty('error', 'No active tab for screenshot translation');
    expect(mocks.tabs.sendMessage).not.toHaveBeenCalled();
  });
  it('refuses to capture a different active tab', async () => {
    mocks.tabs.query.mockResolvedValue([{ id: 99 }]);
    expect(await dispatch({ type: 'CAPTURE_VISIBLE' }, { tab: { id: 42, windowId: 5 } })).toHaveProperty('error');
    expect(mocks.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });
  it('captures the sender window when the correct tab is active', async () => {
    mocks.tabs.query.mockResolvedValue([{ id: 42 }]); mocks.tabs.captureVisibleTab.mockResolvedValue('data:image/png,test');
    expect(await dispatch({ type: 'CAPTURE_VISIBLE' }, { tab: { id: 42, windowId: 5 } })).toEqual({ dataUrl: 'data:image/png,test' });
    expect(mocks.tabs.captureVisibleTab).toHaveBeenCalledExactlyOnceWith(5, { format: 'png' });
  });
});

describe('background hardening', () => {
  it('recreates the context menu without duplicate ids on reinstall/update', async () => {
    const onInstalled = mocks.runtime.onInstalled.addListener.mock.calls[0][0] as () => void;
    const order: string[] = [];
    mocks.contextMenus.removeAll.mockImplementation(async () => { order.push('removeAll'); });
    mocks.contextMenus.create.mockImplementation(() => { order.push('create'); });
    onInstalled(); onInstalled();
    await new Promise(r => setTimeout(r, 0));
    expect(order).toEqual(['removeAll', 'removeAll', 'create', 'create']);
    expect(mocks.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'translate-images' }));
  });
  it('rejects NATIVE_HOST_CALL from a content script in a web page', async () => {
    const res = await dispatch({ type: 'NATIVE_HOST_CALL', request: { action: 'ping' } },
      { id: 'ext-id', url: 'https://evil.example/', tab: { id: 1 } });
    expect(res).toMatchObject({ ok: false });
    expect(mocks.runtime.sendNativeMessage).not.toHaveBeenCalled();
  });
  it('rejects NATIVE_HOST_CALL from another extension', async () => {
    const res = await dispatch({ type: 'NATIVE_HOST_CALL', request: { action: 'ping' } },
      { id: 'other', url: 'chrome-extension://other/offscreen.html' });
    expect(res).toMatchObject({ ok: false });
    expect(mocks.runtime.sendNativeMessage).not.toHaveBeenCalled();
  });
  it('forwards NATIVE_HOST_CALL from the offscreen document', async () => {
    mocks.runtime.sendNativeMessage.mockResolvedValue({ ok: true, version: '1' });
    const res = await dispatch({ type: 'NATIVE_HOST_CALL', request: { action: 'ping' } },
      { id: 'ext-id', url: 'chrome-extension://ext-id/offscreen.html' });
    expect(res).toEqual({ ok: true, version: '1' });
  });
  it('reports openOptionsPage failures instead of claiming success', async () => {
    mocks.runtime.openOptionsPage.mockRejectedValueOnce(new Error('boom'));
    expect(await dispatch({ type: 'OPEN_OPTIONS' })).toMatchObject({ ok: false });
    mocks.runtime.openOptionsPage.mockResolvedValueOnce(undefined);
    expect(await dispatch({ type: 'OPEN_OPTIONS' })).toEqual({ ok: true });
  });
});
