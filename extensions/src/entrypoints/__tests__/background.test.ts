import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  runtime: { onInstalled: { addListener: vi.fn() }, onMessage: { addListener: vi.fn() } },
  tabs: { sendMessage: vi.fn(), query: vi.fn(), captureVisibleTab: vi.fn() },
  contextMenus: { create: vi.fn(), onClicked: { addListener: vi.fn() } },
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
