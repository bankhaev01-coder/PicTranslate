import type {
  Box,
  ImageStatus,
  PageImage,
  Point,
  SelectionRegion,
  SelectionShape,
  TranslateResult,
} from './types';
import { boundsOf, initialBubbleFontSize, lassoPathData, mapBoxToViewport } from './selection';
import i18n from './i18n';

export interface OverlayCallbacks {
  onTranslate: (images: PageImage[]) => void;
  onRegion: (region: SelectionRegion) => void;
  onClose: () => void;
}

interface Row {
  root: HTMLElement;
  statusEl: HTMLElement;
  textEl: HTMLElement;
}

interface BubbleEntry {
  group: HTMLElement;
  boxes: Box[];
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Глифы форм на кнопках панели инструментов. */
const SHAPE_GLYPH: Record<SelectionShape, string> = {
  rectangle: '▭',
  oval: '◯',
  lasso: '✎',
};

/**
 * Оверлей интерфейса поверх страницы в закрытом Shadow DOM, чтобы стили
 * страницы не протекали внутрь. Содержит: плавающую панель управления +
 * подписи перевода, позиционированные над изображениями.
 */
export class OverlayUI {
  private host: HTMLElement;
  private shadow: ShadowRoot;
  private panel!: HTMLElement;
  private listEl!: HTMLElement;
  private progressEl!: HTMLElement;
  private rows = new Map<string, Row>();
  private labels = new Map<string, HTMLElement>();
  private labelsVisible = true;
  private bubbles = new Map<string, BubbleEntry>();
  private selectionActive = false;
  private selShape: SelectionShape = 'rectangle';
  private shapeButtons = new Map<SelectionShape, HTMLElement>();
  private selLayer?: HTMLElement;
  private selCleanup?: () => void;
  private images: PageImage[] = [];
  private cb: OverlayCallbacks;
  private onScroll = () => {
    this.repositionLabels();
    this.repositionBubbles();
  };

  constructor(cb: OverlayCallbacks) {
    this.cb = cb;
    this.host = document.createElement('div');
    this.host.id = 'translate-ext-overlay-host';
    this.host.style.cssText = 'all:initial; position:fixed; inset:0; z-index:2147483647; pointer-events:none;';
    this.shadow = this.host.attachShadow({ mode: 'closed' });
    document.documentElement.appendChild(this.host);
    this.render();
    window.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('resize', this.onScroll);
  }

  private render() {
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;

    this.panel = el('div', { class: 'panel' });
    const header = el('div', { class: 'header' });
    const title = el('span', { class: 'title', text: i18n.t('overlay.panelTitle') });

    const btnTranslate = el('button', {
      class: 'btn primary',
      text: i18n.t('common.translateAll'),
      onclick: () => this.cb.onTranslate(this.images),
    });
    const btnSelect = el('button', {
      class: 'btn',
      text: i18n.t('overlay.selectRegion'),
      onclick: () => (this.selectionActive ? this.stopSelection() : this.startSelection()),
    });
    const btnLabels = el('button', {
      class: 'btn',
      text: i18n.t('overlay.clearLabels'),
      onclick: () => this.toggleLabels(btnLabels),
    });
    const btnClose = el('button', {
      class: 'btn icon',
      text: '✕',
      onclick: () => this.cb.onClose(),
    });

    header.append(title, btnTranslate, btnSelect, btnLabels, btnClose);

    // ── выбор формы (прямоугольник / овал / лассо) ──
    const shapes = el('div', { class: 'shapes' });
    const shapesLabel = el('span', { class: 'shapes-label', text: i18n.t('overlay.shape') });
    shapes.append(shapesLabel);
    (['rectangle', 'oval', 'lasso'] as SelectionShape[]).forEach((shape) => {
      const btn = el('button', {
        class: `btn shape${shape === this.selShape ? ' active' : ''}`,
        text: SHAPE_GLYPH[shape],
        title: i18n.t(`overlay.shape.${shape}`),
        onclick: () => this.setShape(shape),
      });
      this.shapeButtons.set(shape, btn);
      shapes.append(btn);
    });

    this.progressEl = el('div', { class: 'progress' });
    this.listEl = el('div', { class: 'list' });

    this.panel.append(header, shapes, this.progressEl, this.listEl);
    this.shadow.append(style, this.panel);
  }

  setImages(images: PageImage[]) {
    this.images = images;
    this.rows.clear();
    this.listEl.innerHTML = '';
    this.setProgress(0, images.length);

    for (const img of images) {
      const row = el('div', { class: 'row' });
      const thumb = el('img', { class: 'thumb' }) as HTMLImageElement;
      thumb.src = img.src;
      thumb.loading = 'lazy';

      const body = el('div', { class: 'body' });
      const statusEl = el('div', { class: 'status', text: i18n.t('overlay.status.idle') });
      const textEl = el('div', { class: 'text' });
      body.append(statusEl, textEl);

      row.append(thumb, body);
      this.listEl.append(row);
      this.rows.set(img.id, { root: row, statusEl, textEl });
    }
  }

  setStatus(imageId: string, status: ImageStatus, result?: TranslateResult, done = 0, total = 0) {
    const row = this.rows.get(imageId);
    if (row) {
      row.statusEl.textContent = i18n.t(`overlay.status.${status}`);
      row.statusEl.className = `status ${status}`;
      if (result) {
        const text = result.error
          ? `⚠ ${result.error}`
          : result.translation || i18n.t('overlay.noText');
        row.textEl.textContent = text;
      }
    }
    if (status === 'done' || status === 'error') this.setProgress(done, total);

    if (result && !result.error && this.labelsVisible) {
      this.showLabel(imageId, result.translation);
    }
  }

  setProgress(done: number, total: number) {
    this.progressEl.textContent = total
      ? i18n.t('overlay.progress', { done, total })
      : i18n.t('overlay.found', { count: 0 });
  }

  private showLabel(imageId: string, text: string) {
    let label = this.labels.get(imageId);
    if (!label) {
      label = el('div', { class: 'label' });
      this.shadow.append(label);
      this.labels.set(imageId, label);
    }
    label.textContent = text;
    label.dataset.imageId = imageId;
    this.positionLabel(label, imageId);
  }

  private positionLabel(label: HTMLElement, imageId: string) {
    const img = document.querySelector<HTMLImageElement>(`img[data-translate-ext-id="${imageId}"]`);
    if (!img) {
      label.style.display = 'none';
      return;
    }
    const r = img.getBoundingClientRect();
    label.style.display = 'block';
    label.style.left = `${Math.max(4, r.left)}px`;
    label.style.top = `${Math.max(4, r.top)}px`;
    label.style.maxWidth = `${Math.max(120, Math.min(r.width, window.innerWidth - 24))}px`;
  }

  private repositionLabels() {
    for (const [id, label] of this.labels) this.positionLabel(label, id);
  }

  private toggleLabels(btn: HTMLElement) {
    this.labelsVisible = !this.labelsVisible;
    for (const label of this.labels.values()) label.style.display = this.labelsVisible ? 'block' : 'none';
    btn.textContent = this.labelsVisible ? i18n.t('overlay.clearLabels') : i18n.t('overlay.showLabels');
    if (this.labelsVisible) this.repositionLabels();
  }

  /* ── результат выделения (инструмент области) ──────────── */

  /** Показать временную подпись перевода, привязанную к границам выделения. */
  showRegionResult(region: SelectionRegion, text: string) {
    const b = region.bounds;
    const label = el('div', { class: 'label region-label' });
    label.textContent = text;
    label.style.left = `${Math.max(4, b.x)}px`;
    label.style.top = `${Math.max(4, b.y + b.height + 6)}px`;
    label.style.maxWidth = `${Math.max(140, Math.min(b.width, window.innerWidth - 24))}px`;
    this.shadow.append(label);
    setTimeout(() => label.remove(), 15_000);
  }

  /* ── комикс-пузыри речи ───────────────────────────────── */

  /**
   * Рисует речевые пузыри в стиле комикса для каждого найденного текстового
   * прямоугольника изображения. Прямоугольники заданы в пиксельном
   * пространстве исходника и отображаются на границы отрисованного <img>,
   * поэтому пузыри следуют за скроллом и ресайзом окна.
   */
  showBubbles(imageId: string, boxes: Box[]) {
    this.clearBubbles(imageId);
    const withText = boxes.filter((b) => (b.translation ?? '').trim().length > 0);
    if (!withText.length) return;

    const group = el('div', { class: 'bubbles' });
    group.dataset.imageId = imageId;
    for (const box of withText) {
      const bubble = el('div', { class: 'bubble' });
      const text = el('span', { class: 'bubble-text', text: box.translation ?? '' });
      bubble.append(text);
      group.append(bubble);
    }

    this.shadow.append(group);
    this.bubbles.set(imageId, { group, boxes: withText });
    this.positionBubbles(imageId);
  }

  /** Убрать пузыри одного изображения (или всех, если id не задан). */
  clearBubbles(imageId?: string) {
    if (imageId) {
      this.bubbles.get(imageId)?.group.remove();
      this.bubbles.delete(imageId);
      return;
    }
    for (const entry of this.bubbles.values()) entry.group.remove();
    this.bubbles.clear();
  }

  private positionBubbles(imageId: string) {
    const entry = this.bubbles.get(imageId);
    if (!entry) return;

    const img = document.querySelector<HTMLImageElement>(`img[data-translate-ext-id="${imageId}"]`);
    if (!img || !img.naturalWidth || !img.naturalHeight) {
      entry.group.style.display = 'none';
      return;
    }
    const r = img.getBoundingClientRect();
    if (r.bottom < -80 || r.top > window.innerHeight + 80) {
      entry.group.style.display = 'none';
      return;
    }
    entry.group.style.display = 'block';

    const imageRect = { left: r.left, top: r.top, width: r.width, height: r.height };

    entry.boxes.forEach((box, i) => {
      const bubble = entry.group.children[i] as HTMLElement | undefined;
      const text = bubble?.firstElementChild as HTMLElement | null;
      if (!bubble || !text) return;

      const vp = mapBoxToViewport(box, imageRect, img.naturalWidth, img.naturalHeight);
      Object.assign(bubble.style, {
        left: `${vp.left}px`,
        top: `${vp.top}px`,
        width: `${vp.width}px`,
        height: `${vp.height}px`,
      });
      fitBubbleText(bubble, text, vp.width, vp.height);
    });
  }

  private repositionBubbles() {
    for (const id of this.bubbles.keys()) this.positionBubbles(id);
  }

  private setShape(shape: SelectionShape) {
    this.selShape = shape;
    for (const [id, btn] of this.shapeButtons) {
      btn.classList.toggle('active', id === shape);
    }
    if (this.selectionActive) {
      this.stopSelection();
      this.startSelection();
    }
  }

  /* ── инструмент выделения (прямоугольник / овал / лассо) ──── */

  private startSelection() {
    if (this.selectionActive) return;
    this.selectionActive = true;

    this.selLayer = el('div', { class: 'sel-layer' });
    const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    svg.setAttribute('class', 'sel-svg');
    const shapeEl = createShapeElement(this.selShape);
    svg.append(shapeEl);

    const hint = el('div', {
      class: 'sel-hint',
      text: i18n.t(`overlay.selectHint.${this.selShape}`),
    });
    this.selLayer.append(svg, hint);
    this.shadow.append(this.selLayer);

    let start: Point | null = null;
    let points: Point[] = [];

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY };
      points = [start];
      shapeEl.style.display = 'block';
      applyShape(shapeEl, this.selShape, start, points);
    };

    const onMove = (e: MouseEvent) => {
      if (!start) return;
      const p = { x: e.clientX, y: e.clientY };
      if (this.selShape === 'lasso') points.push(p);
      else points = [start, p];
      applyShape(shapeEl, this.selShape, start, points);
    };

    const onUp = (e: MouseEvent) => {
      if (!start) return;
      const p = { x: e.clientX, y: e.clientY };
      points = this.selShape === 'lasso' ? [...points, p] : [start, p];

      const shape = this.selShape;
      const captured = points;
      const bounds = boundsOf(captured);
      this.stopSelection();
      if (bounds.width < 8 || bounds.height < 8) return;
      this.cb.onRegion({
        shape,
        bounds,
        points: shape === 'lasso' ? captured : undefined,
      });
    };

    this.selLayer.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    this.selCleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }

  private stopSelection() {
    this.selectionActive = false;
    this.selCleanup?.();
    this.selCleanup = undefined;
    this.selLayer?.remove();
    this.selLayer = undefined;
  }

  destroy() {
    this.stopSelection();
    this.clearBubbles();
    window.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('resize', this.onScroll);
    this.host.remove();
  }
}

/* ── вспомогательные функции ────────────────────────────── */

type Props = { class?: string; text?: string; onclick?: (e: MouseEvent) => void } & Record<string, unknown>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') node.textContent = String(v);
    else if (k === 'class') node.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else node.setAttribute(k, String(v));
  }
  return node;
}

/** Собрать SVG-элемент для предпросмотра выбранной формы выделения. */
function createShapeElement(shape: SelectionShape): SVGElement {
  const tag = shape === 'rectangle' ? 'rect' : shape === 'oval' ? 'ellipse' : 'path';
  const node = document.createElementNS(SVG_NS, tag) as SVGElement;
  node.setAttribute('class', 'sel-shape');
  node.style.display = 'none';
  return node;
}

/** Обновить геометрию предпросмотра для активной формы. */
function applyShape(shapeEl: SVGElement, shape: SelectionShape, start: Point, points: Point[]) {
  const last = points[points.length - 1] ?? start;

  if (shape === 'rectangle') {
    shapeEl.setAttribute('x', String(Math.min(start.x, last.x)));
    shapeEl.setAttribute('y', String(Math.min(start.y, last.y)));
    shapeEl.setAttribute('width', String(Math.abs(last.x - start.x)));
    shapeEl.setAttribute('height', String(Math.abs(last.y - start.y)));
    return;
  }
  if (shape === 'oval') {
    shapeEl.setAttribute('cx', String((start.x + last.x) / 2));
    shapeEl.setAttribute('cy', String((start.y + last.y) / 2));
    shapeEl.setAttribute('rx', String(Math.abs(last.x - start.x) / 2));
    shapeEl.setAttribute('ry', String(Math.abs(last.y - start.y) / 2));
    return;
  }
  // Лассо: замкнутая ломаная через все записанные позиции курсора.
  shapeEl.setAttribute('d', lassoPathData(points));
}

/**
 * Уменьшать размер шрифта, пока перевод не поместится в речевой пузырь.
 * Пузырь обрезает переполнение; текст сохраняет естественный перенос, чтобы
 * замер отражал то, что реально увидит пользователь.
 */
function fitBubbleText(bubble: HTMLElement, text: HTMLElement, w: number, h: number) {
  const pad = 6;
  const availH = Math.max(14, h - pad * 2);
  let size = initialBubbleFontSize(h, pad);
  text.style.fontSize = `${size}px`;
  for (let guard = 0; guard < 14; guard += 1) {
    if (text.scrollHeight <= availH) break;
    size -= 1;
    if (size <= 8) break;
    text.style.fontSize = `${size}px`;
  }
  // Страховка от горизонтального переполнения неразрывным словом.
  bubble.style.overflowWrap = 'anywhere';
  if (text.scrollWidth > Math.max(10, w - pad * 2) && size > 8) {
    text.style.fontSize = `${Math.max(8, size - 1)}px`;
  }
}

const OVERLAY_CSS = `
:host { all: initial; }
.panel {
  pointer-events: auto;
  position: fixed; top: 12px; right: 12px; width: 340px; max-height: 70vh;
  display: flex; flex-direction: column;
  background: #ffffff; color: #1a1a1a;
  border: 1px solid #d0d0d0; border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.18);
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.header { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #eee; }
.title { font-weight: 600; margin-right: auto; }
.btn {
  border: 1px solid #ccc; background: #f6f6f6; color: inherit; border-radius: 6px;
  padding: 4px 8px; font-size: 12px; cursor: pointer;
}
.btn:hover { background: #ececec; }
.btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
.btn.primary:hover { background: #1d4ed8; }
.btn.icon { padding: 2px 7px; }
.shapes {
  display: flex; align-items: center; gap: 4px;
  padding: 6px 10px; border-bottom: 1px solid #f1f1f1;
}
.shapes-label { color: #666; font-size: 12px; margin-right: 2px; }
.btn.shape { padding: 2px 8px; font-size: 14px; line-height: 1.1; }
.btn.shape.active { background: #2563eb; border-color: #2563eb; color: #fff; }
.progress { padding: 6px 10px; color: #666; font-size: 12px; border-bottom: 1px solid #f1f1f1; }
.list { overflow: auto; padding: 6px; }
.row { display: flex; gap: 8px; padding: 6px; border-radius: 6px; }
.row:hover { background: #f7f7f7; }
.thumb { width: 48px; height: 48px; object-fit: cover; border-radius: 6px; background: #eee; flex: none; }
.body { min-width: 0; }
.status { font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: #888; }
.status.working { color: #b45309; }
.status.done { color: #15803d; }
.status.error { color: #b91c1c; }
.text { white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
.label {
  pointer-events: none; position: fixed; z-index: 2147483647;
  background: rgba(17,24,39,.92); color: #fff; border-radius: 6px;
  padding: 6px 8px; font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  white-space: pre-wrap; box-shadow: 0 4px 14px rgba(0,0,0,.25);
}
.sel-layer { position: fixed; inset: 0; cursor: crosshair; pointer-events: auto; background: rgba(37,99,235,.06); }
.sel-svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.sel-shape { fill: rgba(37,99,235,.12); stroke: #2563eb; stroke-width: 2; stroke-dasharray: 6 4; }

/* ── comic speech bubbles ── */
.bubbles { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
.bubble {
  position: fixed; display: flex; align-items: center; justify-content: center;
  box-sizing: border-box; padding: 6px; overflow: hidden;
  background: #ffffff; color: #111111;
  border: 2px solid #111111; border-radius: 50%;
  box-shadow: 0 2px 8px rgba(0,0,0,.22);
  text-align: center;
}
.bubble-text {
  display: block; width: 100%;
  font: 13px/1.15 "Comic Sans MS", "Segoe UI", system-ui, sans-serif;
  font-weight: 600; letter-spacing: .01em;
  word-break: break-word; overflow-wrap: anywhere;
}
.sel-hint {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  background: rgba(17,24,39,.92); color: #fff; padding: 8px 12px; border-radius: 8px;
  font: 13px system-ui, sans-serif;
}
`;

