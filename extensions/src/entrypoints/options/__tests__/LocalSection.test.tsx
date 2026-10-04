// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ vendor: vi.fn(), list: vi.fn(), download: vi.fn(), remove: vi.fn(), permission: vi.fn(), patch: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { permissions: { request: mocks.permission } } }));
vi.mock('@/lib/local/ocrModels', async original => ({ ...(await original<object>()), listDownloadedOcrModels: mocks.list, downloadOcrModel: mocks.download, removeOcrModel: mocks.remove }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/local/vendor', () => ({ getVendorManifest: mocks.vendor }));
import LocalSection from '../LocalSection';
import { DEFAULT_SETTINGS } from '../../../lib/constants';
import type { Settings } from '../../../lib/types';
const ocrPack = { version: 1, baseUrl: '', pairs: [], ocrLangs: ['eng', 'rus'], tesseract: true, createdAt: 'test' };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLElement;
beforeEach(() => { vi.clearAllMocks(); mocks.vendor.mockResolvedValue(ocrPack); mocks.list.mockResolvedValue([]); mocks.permission.mockResolvedValue(true); mocks.download.mockResolvedValue(undefined); mocks.remove.mockResolvedValue(undefined); });
afterEach(() => { if (root) act(() => root?.unmount()); document.body.replaceChildren(); });
async function render(patch: Partial<Settings> = {}) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(<LocalSection settings={{ ...DEFAULT_SETTINGS, ocrLangs: ['eng'], ...patch }} patch={mocks.patch} />); });
  return container.querySelector('.resource-status') as HTMLElement | null;
}

describe('LocalSection OCR-only pack readiness', () => {
  it('accepts the shipped OCR-only pack with Google without requesting Opus-MT', async () => {
    const status = await render({ externalMt: 'google' });
    expect(status?.textContent).toBe('✓ options.ocrExternalReady');
    expect(status?.classList.contains('ok')).toBe(true);
    expect(container.textContent).not.toContain('options.offlinePackMissing');
    expect(container.textContent).toContain('options.mtOptionalHint');
    expect(container.textContent).toContain('options.ocrOnlyVendorHint');
  });
  it('explains missing local MT separately when external translation is disabled', async () => {
    expect((await render({ externalMt: 'off' }))?.textContent).toBe('⚠ options.localMtMissing');
    expect(container.textContent).not.toContain('options.ocrPackMissing');
  });
  it('recognizes a full offline pack', async () => {
    mocks.vendor.mockResolvedValue({ ...ocrPack, pairs: ['en-ru'] });
    expect((await render())?.textContent).toBe('✓ options.offlinePackReady');
  });
  it('does not hide a genuinely missing OCR pack just because Google is selected', async () => {
    mocks.vendor.mockResolvedValue(null);
    const status = await render({ externalMt: 'google' });
    expect(status?.textContent).toBe('⚠ options.ocrPackMissing');
    expect(status?.classList.contains('fail')).toBe(true);
  });
  it('checks the requested OCR language instead of just a manifest flag', async () => {
    expect((await render({ externalMt: 'google', ocrLangs: ['jpn'] }))?.textContent).toBe('⚠ options.ocrPackMissing');
  });
  it('accepts an explicitly selected native OCR host without a bundled OCR pack', async () => {
    mocks.vendor.mockResolvedValue(null);
    expect((await render({ externalMt: 'google', useNativeHost: true }))?.textContent).toBe('✓ options.ocrExternalReady');
  });
  it('does not flash a missing-resource warning while the manifest is loading', async () => {
    mocks.vendor.mockImplementation(() => new Promise(() => {}));
    expect(await render({ externalMt: 'google' })).toBeNull();
    expect(container.textContent).not.toContain('options.offlinePackMissing');
  });
});

describe('OCR model controls', () => {
  const japaneseButton = () => container.querySelector('button[aria-label="options.ocrModelDownload: 日本語"]') as HTMLButtonElement;
  it('offers on-demand downloads but never starts them on render', async () => {
    await render(); expect(japaneseButton()).not.toBeNull();
    expect(mocks.download).not.toHaveBeenCalled(); expect(mocks.permission).not.toHaveBeenCalled();
  });
  it('requests only the model host, installs on click, and leaves language selection unchanged', async () => {
    await render();
    mocks.list.mockResolvedValue([{ id: 'jpn', bytes: 1024, installedAt: 'test' }]);
    mocks.vendor.mockResolvedValue({ ...ocrPack, ocrLangs: ['eng', 'rus', 'jpn'], bundledOcrLangs: ['eng', 'rus'] });
    await act(async () => japaneseButton().click());
    expect(mocks.permission).toHaveBeenCalledWith({ origins: ['https://tessdata.projectnaptha.com/*'] });
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith('jpn');
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(container.querySelector('button[aria-label="options.ocrModelRemove: 日本語"]')).not.toBeNull();
  });
  it('does not download after permission denial and shows a retryable error', async () => {
    mocks.permission.mockResolvedValue(false); await render();
    await act(async () => japaneseButton().click());
    expect(mocks.download).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('options.ocrDownloadPermissionDenied');
    expect(japaneseButton().disabled).toBe(false);
  });
  it('requires every selected model instead of accepting a partial language set', async () => {
    expect((await render({ ocrLangs: ['eng', 'jpn'], externalMt: 'google' }))?.textContent).toBe('⚠ options.ocrPackMissing');
  });
});
