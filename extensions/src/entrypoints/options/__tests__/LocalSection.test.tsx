// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ vendor: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/local/vendor', () => ({ getVendorManifest: mocks.vendor }));
import LocalSection from '../LocalSection';
import { DEFAULT_SETTINGS } from '../../../lib/constants';
import type { Settings } from '../../../lib/types';
const ocrPack = { version: 1, baseUrl: '', pairs: [], ocrLangs: ['eng', 'rus'], tesseract: true, createdAt: 'test' };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLElement;
beforeEach(() => { vi.clearAllMocks(); mocks.vendor.mockResolvedValue(ocrPack); });
afterEach(() => { if (root) act(() => root?.unmount()); document.body.replaceChildren(); });
async function render(patch: Partial<Settings> = {}) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(<LocalSection settings={{ ...DEFAULT_SETTINGS, ocrLangs: ['eng'], ...patch }} patch={vi.fn()} />); });
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
