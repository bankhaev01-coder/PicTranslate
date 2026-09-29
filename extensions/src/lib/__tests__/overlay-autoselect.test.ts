// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { OverlayUI, type OverlayCallbacks } from '../overlay';
import type { SelectionRegion } from '../types';

/** Private OverlayUI members needed by these tests. */
interface OverlayInternals {
  startSelection: () => void;
  removeRegion: (id: string) => void;
  regions: SelectionRegion[];
  selLayer: HTMLElement;
  host: HTMLElement;
  shadow: ShadowRoot;
  btnTranslateSelected: HTMLButtonElement;
  setCaptureHidden: (hidden: boolean) => void;
  showRegionResult: (region: SelectionRegion, text: string, translated?: boolean) => void;
}

const internals = (ov: OverlayUI) => ov as unknown as OverlayInternals;

function makeCallbacks(): OverlayCallbacks {
  return {
    onTranslate: vi.fn(),
    onRegionsSelected: vi.fn(),
    onRemoveImage: vi.fn(),
    onClose: vi.fn(),
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
 * Regression: a selected region goes to the translate queue right away
 * (onRegionSelected on mouseup), so the user does not have to keep the area
 * visible until pressing the button - the frame is captured on the spot.
 */
describe('OverlayUI auto-queue of a selection', () => {
  it('fires onRegionSelected right after mouseup for every region', () => {
    const onRegionSelected = vi.fn();
    const cb = makeCallbacks();
    cb.onRegionSelected = onRegionSelected;
    const ov = new OverlayUI(cb, 'oval', 3);

    const regions = drawRegion(ov, 10, 10, 60, 80);
    expect(onRegionSelected).toHaveBeenCalledTimes(1);
    const region = onRegionSelected.mock.calls[0][0] as SelectionRegion;
    expect(region).toBe(regions[0]);
    expect(region.id).toBe('r1');
    expect(region.token).toBe(3);
    expect(region.shape).toBe('rectangle'); // default selection shape
    expect(region.bounds.width).toBe(50);
    expect(region.bounds.height).toBe(70);

    drawRegion(ov, 90, 10, 140, 60);
    expect(onRegionSelected).toHaveBeenCalledTimes(2);
    expect(internals(ov).regions).toHaveLength(2);
  });

  it('does not queue a too-small accidental movement', () => {
    const onRegionSelected = vi.fn();
    const cb = makeCallbacks();
    cb.onRegionSelected = onRegionSelected;
    const ov = new OverlayUI(cb, 'rectangle');

    drawRegion(ov, 10, 10, 12, 12);
    expect(onRegionSelected).not.toHaveBeenCalled();
    expect(internals(ov).regions).toHaveLength(0);
  });
});

/**
 * During a snapshot the selection layer must stay clickable (a capture runs
 * on every mouseup and an mousedown inside that window must not be lost),
 * while its content (hint, shape preview) must stay out of the frame.
 */
describe('OverlayUI capture hiding keeps the selection usable', () => {
  it('hides host and children but keeps selection layer visible and transparent', () => {
    const ov = new OverlayUI(makeCallbacks(), 'oval', 1);
    drawRegion(ov, 10, 10, 60, 80); // stays in selection mode
    const iv = internals(ov);

    iv.setCaptureHidden(true);
    expect(iv.host.style.visibility).toBe('hidden');
    expect(iv.selLayer.style.visibility).toBe('visible');
    expect(iv.selLayer.style.background).toBe('transparent');
    for (const child of Array.from(iv.selLayer.children)) {
      expect((child as HTMLElement).style.visibility).toBe('hidden');
    }

    iv.setCaptureHidden(false);
    expect(iv.host.style.visibility).toBe('');
    expect(iv.selLayer.style.visibility).toBe('');
    expect(iv.selLayer.style.background).toBe('');
    for (const child of Array.from(iv.selLayer.children)) {
      expect((child as HTMLElement).style.visibility).toBe('');
    }
  });
});

/**
 * The result plate is only drawn for a region that still exists (a region
 * cancelled while its crop was queued must not leave a plate behind), and
 * the translated flag it carries gates the re-order button.
 */
describe('OverlayUI showRegionResult', () => {
  it('draws a plate for a live region and disables the button when all are done', () => {
    const ov = new OverlayUI(makeCallbacks(), 'oval', 1);
    const regions = drawRegion(ov, 10, 10, 60, 80);
    const iv = internals(ov);
    expect(iv.btnTranslateSelected.disabled).toBe(false);

    iv.showRegionResult(regions[0], 'hello', true);
    expect(iv.shadow.querySelectorAll('.region-plate')).toHaveLength(1);
    expect(iv.btnTranslateSelected.disabled).toBe(true);
  });

  it('keeps the button enabled on failure and drops plates of removed regions', () => {
    const ov = new OverlayUI(makeCallbacks(), 'oval', 1);
    const regions = drawRegion(ov, 10, 10, 60, 80);
    const iv = internals(ov);

    const region = regions[0]!;

    iv.showRegionResult(region, 'boom', false);
    expect(iv.shadow.querySelectorAll('.region-plate')).toHaveLength(1);
    expect(iv.btnTranslateSelected.disabled).toBe(false);

    iv.removeRegion(region.id!);
    expect(iv.shadow.querySelectorAll('.region-plate')).toHaveLength(0);
    iv.showRegionResult(region, 'stale', false);
    expect(iv.shadow.querySelectorAll('.region-plate')).toHaveLength(0);
  });
});