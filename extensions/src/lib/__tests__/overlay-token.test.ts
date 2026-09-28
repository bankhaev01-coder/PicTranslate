// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { OverlayUI, type OverlayCallbacks } from '../overlay';
import type { SelectionRegion } from '../types';

/** Приватные поля OverlayUI, нужные для проверки поколения выделения. */
interface OverlayInternals {
  startSelection: () => void;
  clearRegions: () => void;
  translateSelected: () => void;
  selLayer: HTMLElement;
  btnTranslateSelected: HTMLButtonElement;
  regions: SelectionRegion[];
  regionToken: number;
}

const internals = (ov: OverlayUI) => ov as unknown as OverlayInternals;

function makeCallbacks(onRegionsCleared = vi.fn()): OverlayCallbacks {
  return {
    onTranslate: vi.fn(),
    onRegionsSelected: vi.fn(),
    onRemoveImage: vi.fn(),
    onRegionRemoved: vi.fn(),
    onRegionsCleared,
    onClose: vi.fn(),
  };
}

/** Нарисовать прямоугольную область мышью в уже включённом режиме выделения. */
function drawRegion(ov: OverlayUI, x1: number, y1: number, x2: number, y2: number): SelectionRegion[] {
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
 * Регрессия: injected сравнивает token области с batchToken (поколение скана).
 * OverlayUI должен получать текущее поколение извне — иначе все результаты
 * перевода области молча дропаются как устаревшие (найдено E2E на MangaDex).
 */
describe('OverlayUI: поколение выделения', () => {
  it('штампует новые области токеном, переданным injected', () => {
    const ov = new OverlayUI(makeCallbacks(), 'oval', 1);
    const regions = drawRegion(ov, 10, 10, 60, 80);
    expect(regions).toHaveLength(1);
    expect(regions[0].token).toBe(1);
  });

  it('без initialToken сохраняет прежнее поведение (поколение 0)', () => {
    const ov = new OverlayUI(makeCallbacks(), 'oval');
    const regions = drawRegion(ov, 10, 10, 60, 80);
    expect(regions[0].token).toBe(0);
  });

  it('после сброса области получают следующее поколение и injected уведомляется', () => {
    const onCleared = vi.fn();
    const ov = new OverlayUI(makeCallbacks(onCleared), 'oval', 1);
    drawRegion(ov, 10, 10, 60, 80);
    internals(ov).clearRegions();
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(internals(ov).regionToken).toBe(2);
    const regions = drawRegion(ov, 10, 10, 90, 80);
    expect(regions).toHaveLength(1);
    expect(regions[0].token).toBe(2);
  });
});

/**
 * Регрессия: onRegionsSelected обязан возвращать промис пачки в overlay.
 * Пока injected отдавал void, finally срабатывал мгновенно и второй Enter
 * во время перевода запускал дублирующий capture+OCR+MT (найдено E2E).
 */
describe('OverlayUI: блокировка пачки', () => {
  it('держит кнопку «Translate selected» выключенной, пока пачка не завершена', async () => {
    let release!: () => void;
    const pending = new Promise<void>((res) => {
      release = res;
    });
    const onRegionsSelected = vi.fn(() => pending);
    const cb = makeCallbacks();
    cb.onRegionsSelected = onRegionsSelected;

    const ov = new OverlayUI(cb, 'oval', 1);
    drawRegion(ov, 10, 10, 60, 80);
    const iv = internals(ov);

    iv.translateSelected();
    expect(onRegionsSelected).toHaveBeenCalledTimes(1);
    expect(iv.btnTranslateSelected.disabled).toBe(true);

    // Второй Enter/клик во время полёта — игнорируется, повторной пачки нет.
    iv.translateSelected();
    expect(onRegionsSelected).toHaveBeenCalledTimes(1);
    expect(iv.btnTranslateSelected.disabled).toBe(true);

    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(iv.btnTranslateSelected.disabled).toBe(false);
  });
});

