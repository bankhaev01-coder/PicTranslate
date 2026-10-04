// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverlayUI } from '../overlay';
import { readViewportFrame } from '../viewportTranslation';
import type { TranslateResult } from '../types';
interface Internals { shadow: ShadowRoot; toggleLabels: (button: HTMLElement) => void }
const internals = (overlay: OverlayUI) => overlay as unknown as Internals;
let overlay: OverlayUI;
const result: TranslateResult = { source_text: 'source', translation: 'whole page', model: 'test', latency_ms: 1,
  boxes: [{ x: 10, y: 20, width: 100, height: 60, text: 'source', translation: 'one dialogue' }] };
function setup(shape: 'oval' | 'none' = 'oval') {
  overlay = new OverlayUI({ onTranslate: vi.fn(), onRegionsSelected: vi.fn(), onRemoveImage: vi.fn() }, shape);
  const img = document.createElement('img'); img.dataset.translateExtId = 'img';
  Object.defineProperties(img, { naturalWidth: { value: 1000 }, naturalHeight: { value: 1000 } });
  img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 500, bottom: 500 } as DOMRect);
  document.body.append(img);
  overlay.setImages([{ id: 'img', src: 'example.png', width: 1000, height: 1000, visible: true }]);
  return internals(overlay).shadow;
}
beforeEach(() => { Object.defineProperties(window, { scrollX: { value: 0, configurable: true }, scrollY: { value: 0, configurable: true } }); });
afterEach(() => { overlay?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('OverlayUI page dialogue presentation', () => {
  it('renders one dialogue bubble without a duplicate whole-page label', () => {
    const shadow = setup(); overlay.setStatus('img', 'done', result);
    expect(shadow.querySelectorAll('.bubble')).toHaveLength(1);
    expect(shadow.querySelector('.bubble')?.textContent).toBe('one dialogue');
    expect(shadow.querySelectorAll('.label')).toHaveLength(0);
    expect(shadow.querySelector('.row .text')?.textContent).toBe('whole page');
  });
  it('uses the image label only when there are no usable boxes or bubbles are disabled', () => {
    let shadow = setup(); overlay.setStatus('img', 'done', { ...result, boxes: [] });
    expect(shadow.querySelector('.label')?.textContent).toBe('whole page'); overlay.destroy();
    shadow = setup('none'); overlay.setStatus('img', 'done', result);
    expect(shadow.querySelectorAll('.bubble')).toHaveLength(0);
    expect(shadow.querySelector('.label')?.textContent).toBe('whole page');
  });
  it('replaces an old fallback label when a retry obtains proper boxes', () => {
    const shadow = setup(); overlay.setStatus('img', 'done', { ...result, boxes: [] });
    overlay.setStatus('img', 'done', result);
    expect(shadow.querySelectorAll('.label')).toHaveLength(0); expect(shadow.querySelectorAll('.bubble')).toHaveLength(1);
  });
  it('renders screenshot boxes on the document and follows scrolling', () => {
    const shadow = setup(); const frame = { ...readViewportFrame(), scrollY: 100 };
    overlay.showViewportResult(frame, { width: frame.width * 2, height: frame.height * 2 }, result);
    const bubble = shadow.querySelector('.viewport-bubbles .bubble') as HTMLElement;
    expect(bubble.style.left).toBe('5px'); expect(bubble.style.top).toBe('110px');
    Object.defineProperty(window, 'scrollY', { value: 70, configurable: true }); window.dispatchEvent(new Event('scroll'));
    expect(bubble.style.top).toBe('40px'); expect(bubble.style.width).toBe('50px');
    expect(shadow.querySelectorAll('.label')).toHaveLength(0);
  });
  it('replaces a previous snapshot instead of accumulating duplicate bubbles', () => {
    const shadow = setup(); const frame = readViewportFrame();
    overlay.showViewportResult(frame, { width: frame.width, height: frame.height }, result);
    overlay.showViewportResult(frame, { width: frame.width, height: frame.height }, { ...result, translation: 'new' });
    expect(shadow.querySelectorAll('.viewport-bubbles')).toHaveLength(1);
    expect(shadow.querySelectorAll('.row')).toHaveLength(2);
    expect(shadow.querySelector('.row .text')?.textContent).toBe('new');
  });
  it('hides snapshot bubbles during capture and applies the translations visibility toggle', () => {
    const shadow = setup(); const frame = readViewportFrame();
    overlay.showViewportResult(frame, { width: frame.width, height: frame.height }, result);
    overlay.setCaptureHidden(true);
    expect((document.querySelector('#translate-ext-overlay-host') as HTMLElement).style.visibility).toBe('hidden');
    overlay.setCaptureHidden(false);
    internals(overlay).toggleLabels(document.createElement('button'));
    expect((shadow.querySelector('.viewport-bubbles') as HTMLElement).style.display).toBe('none');
    internals(overlay).toggleLabels(document.createElement('button'));
    expect((shadow.querySelector('.viewport-bubbles') as HTMLElement).style.display).toBe('block');
  });
  it('invalidates snapshot bubbles on resize instead of displaying incorrect coordinates', () => {
    const shadow = setup(); const frame = readViewportFrame();
    overlay.showViewportResult(frame, { width: frame.width, height: frame.height }, result);
    const oldWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: oldWidth + 20, configurable: true }); window.dispatchEvent(new Event('resize'));
    expect(shadow.querySelectorAll('.viewport-bubbles')).toHaveLength(0);
    Object.defineProperty(window, 'innerWidth', { value: oldWidth, configurable: true });
  });
  it('uses a separate source rectangle mask while preserving the chosen oval frame', () => {
    const shadow = setup();
    overlay.setStatus('img', 'done', { ...result, boxes: result.boxes!.map(b => ({ ...b, maskSource: true })) });
    expect(shadow.querySelector('.bubble')?.classList.contains('oval')).toBe(true);
    expect(shadow.querySelector('.bubble .source-mask')).not.toBeNull();
    expect(shadow.querySelector('.bubble .bubble-text')?.textContent).toBe('one dialogue');
    expect((shadow.querySelector('.bubble') as HTMLElement).style.left).toBe('5px');
  });
  it('shows OCR source and engine as inert text and replaces old diagnostics on retry', () => {
    const shadow = setup();
    overlay.setStatus('img', 'done', { ...result, source_text: '<img src=x onerror=alert(1)>' });
    expect(shadow.querySelector('.source-text')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(shadow.querySelector('.source-details img')).toBeNull();
    expect(shadow.querySelector('.source-model')?.textContent).toContain('test');
    overlay.setStatus('img', 'done', { ...result, source_text: 'new OCR' });
    expect(shadow.querySelectorAll('.source-details')).toHaveLength(1);
    expect(shadow.querySelector('.source-text')?.textContent).toBe('new OCR');
  });
  it('renders source masks and source diagnostics for viewport captures as well', () => {
    const shadow = setup(); const frame = readViewportFrame();
    overlay.showViewportResult(frame, { width: frame.width, height: frame.height }, {
      ...result, boxes: result.boxes!.map(b => ({ ...b, maskSource: true })) });
    expect(shadow.querySelector('.viewport-bubbles .source-mask')).not.toBeNull();
    expect(shadow.querySelector('.row .source-text')?.textContent).toBe('source');
    expect(shadow.querySelector('.viewport-bubbles .bubble-text')?.textContent).toBe('one dialogue');
  });

});
