// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { OverlayUI, type OverlayCallbacks } from '../overlay';
import type { SelectionRegion } from '../types';

/** Private OverlayUI members needed by these tests. */
interface OverlayInternals {
  startSelection: () => void;
  regions: SelectionRegion[];
  selLayer: HTMLElement;
  host: HTMLElement;
  shadow: ShadowRoot;
  panel: HTMLElement;
  panelFab: HTMLElement;
  showRegionResult: (region: SelectionRegion, text: string, translated?: boolean) => void;
}

const internals = (ov: OverlayUI) => ov as unknown as OverlayInternals;

function makeCallbacks(): OverlayCallbacks {
  return {
    onTranslate: vi.fn(),
    onRegionsSelected: vi.fn(),
    onRemoveImage: vi.fn(),
  };
}

/** Draw a rectangle with the mouse in an already active selection mode. */
function drawRegion(
  ov: OverlayUI,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): SelectionRegion[] {
  const iv = internals(ov);
  iv.startSelection();
  iv.selLayer.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: x1, clientY: y1 }),
  );
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: x2, clientY: y2 }));
  window.dispatchEvent(new MouseEvent('mouseup', { clientX: x2, clientY: y2 }));
  return iv.regions;
}

/**
 * Regression: closing the panel (✕ / Esc / popup «hide») must NOT destroy the
 * translated region plates — only the panel itself hides; a fab button brings
 * the panel back. Full teardown stays reserved for a new scan (destroy).
 */
describe('OverlayUI: closing the panel keeps results', () => {
  it('✕ hides only the panel: plates and marks survive, fab appears', () => {
    const ov = new OverlayUI(makeCallbacks(), 'oval');
    const iv = internals(ov);
    const regions = drawRegion(ov, 10, 10, 60, 80);
    iv.showRegionResult(regions[0], 'hello', true);
    expect(iv.shadow.querySelectorAll('.region-plate')).toHaveLength(1);

    const btnClose = iv.shadow.querySelector('.header .btn.icon') as HTMLButtonElement;
    btnClose.click();

    expect(iv.panel.style.display).toBe('none');
    expect(iv.panelFab.hidden).toBe(false);
    expect(iv.shadow.querySelectorAll('.region-plate')).toHaveLength(1);
    expect(iv.shadow.querySelectorAll('.region-mark')).toHaveLength(1);
    expect(iv.host.isConnected).toBe(true);
    ov.destroy();
  });

  it('fab click brings the panel back', () => {
    const ov = new OverlayUI(makeCallbacks(), 'oval');
    const iv = internals(ov);
    const btnClose = iv.shadow.querySelector('.header .btn.icon') as HTMLButtonElement;
    btnClose.click();
    expect(iv.panel.style.display).toBe('none');

    iv.panelFab.click();

    expect(iv.panel.style.display).not.toBe('none');
    expect(iv.panelFab.hidden).toBe(true);
    ov.destroy();
  });

  it('Esc without regions hides the panel but keeps the overlay alive', () => {
    const ov = new OverlayUI(makeCallbacks(), 'oval');
    const iv = internals(ov);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(iv.panel.style.display).toBe('none');
    expect(iv.panelFab.hidden).toBe(false);
    expect(iv.host.isConnected).toBe(true);
    ov.destroy();
  });

  it('destroy() still removes everything (new-scan semantics)', () => {
    const ov = new OverlayUI(makeCallbacks(), 'oval');
    const iv = internals(ov);
    const regions = drawRegion(ov, 10, 10, 60, 80);
    iv.showRegionResult(regions[0], 'hello', true);

    ov.destroy();

    expect(iv.host.isConnected).toBe(false);
    expect(iv.shadow.querySelectorAll('.region-plate')).toHaveLength(0);
  });
});
