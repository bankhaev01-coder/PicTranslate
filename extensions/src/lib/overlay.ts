import type {
  Box,
  BubbleShape,
  ImageStatus,
  PageImage,
  Point,
  SelectionRegion,
  SelectionShape,
  TranslateResult,
} from './types';
import { boundsOf, initialBubbleFontSize, lassoPathData, mapBoxToViewport, regionKey } from './selection';
import i18n from './i18n';

export interface OverlayCallbacks {
  onTranslate: (images: PageImage[]) => void;
  /**
   * Мульти-выделение: пользователь набрал N областей и нажал «Перевести выбранное».
   * Возвращаемый промис — активная пачка: overlay держит кнопку заблокированной,
   * пока он не завершится (двойной Enter во время перевода — пропуск).
   */
  onRegionsSelected: (regions: SelectionRegion[]) => Promise<void> | void;
  /** Пользователь убрал изображение из очереди (до или во время перевода). */
  onRemoveImage: (imageId: string) => void;
  /** Убрана одна область выделения — сбросить её флаг «переведено». */
  onRegionRemoved?: (regionId: string) => void;
  /** Сброшено всё выделение — сбросить флаги «переведено». */
  onRegionsCleared?: () => void;
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
  /** Показывать ли комикс-пузыри; переключается той же кнопкой, что и плашки. */
  private bubblesVisible = true;
  /** Форма комикс-пузырей ('oval' | 'rectangle' | 'none') из настроек. */
  private bubbleShape: BubbleShape;
  private selectionActive = false;
  private selShape: SelectionShape = 'rectangle';
  private shapeButtons = new Map<SelectionShape, HTMLElement>();
  private selLayer?: HTMLElement;
  private selCleanup?: () => void;
  private images: PageImage[] = [];
  private cb: OverlayCallbacks;
  /** Накопленные области мульти-выделения: живут до «Очистить»/Esc. */
  private regions: SelectionRegion[] = [];
  /** Кнопка «Выделить область»: хранится для подсветки активного режима. */
  private btnSelect!: HTMLElement;
  /** Область уже переведена: id области. Повтор пропускается (п.2). */
  private translatedRegions = new Set<string>();
  /** Перевод областей идёт: защита от двойного Enter (п.2). */
  private regionsBusy = false;
  /** Постоянные контуры выбранных областей в координатах документа. */
  private regionMarks?: HTMLElement;
  /** Поколение выделения: clearRegions гасит прилетевшие позже плашки. */
  private regionToken = 0;
  /** SVG-узлы контуров: id области → узел (для точечного удаления). */
  private regionNodes = new Map<string, SVGElement>();
  /** Плашки переводов поверх областей: якорь в координатах документа. */
  private regionPlates = new Map<
    string,
    { el: HTMLElement; anchor: { x: number; y: number; width: number; height: number } }
  >();
  private regionSeq = 0;
  private selCountEl!: HTMLElement;
  private btnUndoRegion!: HTMLButtonElement;
  private btnTranslateSelected!: HTMLButtonElement;
  private btnClearSelection!: HTMLButtonElement;
  private onScroll = () => {
    this.repositionLabels();
    this.repositionBubbles();
    this.positionRegionMarks();
    this.positionRegionPlates();
  };

  /**
   * initialToken — текущее поколение выделения из injected (batchToken).
   * Области штампуются им и сверяются в injected при показе результата; без
   * синхронизации результаты перевода дропаются как устаревшие (регрессия E2E).
   */
  constructor(cb: OverlayCallbacks, bubbleShape: BubbleShape = 'oval', initialToken = 0) {
    this.regionToken = initialToken;
    this.cb = cb;
    this.bubbleShape = bubbleShape;
    this.host = document.createElement('div');
    this.host.id = 'translate-ext-overlay-host';
    this.host.style.cssText = 'all:initial; position:fixed; inset:0; z-index:2147483647; pointer-events:none;';
    this.shadow = this.host.attachShadow({ mode: 'closed' });
    document.documentElement.appendChild(this.host);
    this.render();
    window.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('resize', this.onScroll);
    window.addEventListener('keydown', this.onKeyDown);
  }

  /**
   * Enter — перевести набранные области, Escape — сбросить выделение (области
   * и их результаты), а если сбрасывать нечего — закрыть панель. Enter не
   * перехватывается, когда фокус в поле ввода на странице.
   */
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && this.regions.length && !isEditableTarget(e.target)) {
      e.preventDefault();
      this.translateSelected();
      return;
    }
    if (e.key !== 'Escape') return;
    if (this.selectionActive || this.regions.length) {
      this.clearRegions();
      this.stopSelection();
      return;
    }
    this.cb.onClose();
  };

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
    this.btnSelect = el('button', {
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

    header.append(title, btnTranslate, this.btnSelect, btnLabels, btnClose);

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

    const selActions = el('div', { class: 'sel-actions' });
    this.selCountEl = el('span', { class: 'sel-count' });
    this.btnUndoRegion = el('button', {
      class: 'btn',
      text: i18n.t('overlay.undoRegion'),
      title: i18n.t('overlay.undoRegionHint'),
      onclick: () => this.removeLastRegion(),
    });
    this.btnTranslateSelected = el('button', {
      class: 'btn primary',
      text: i18n.t('overlay.translateSelected'),
      onclick: () => this.translateSelected(),
    });
    this.btnClearSelection = el('button', {
      class: 'btn',
      text: i18n.t('overlay.clearSelection'),
      title: i18n.t('overlay.clearAllRegions'),
      onclick: () => this.clearRegions(),
    });
    selActions.append(
      this.selCountEl,
      this.btnUndoRegion,
      this.btnTranslateSelected,
      this.btnClearSelection,
    );

    this.progressEl = el('div', { class: 'progress' });
    this.listEl = el('div', { class: 'list' });

    this.panel.append(header, shapes, selActions, this.progressEl, this.listEl);
    this.shadow.append(style, this.panel);
    this.updateSelectionUI();
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

      // ✕ — убрать картинку из очереди (до старта или прямо во время перевода).
      const btnRemove = el('button', {
        class: 'btn icon remove',
        text: '✕',
        title: i18n.t('overlay.removeFromQueue'),
        onclick: () => this.removeImage(img.id),
      });

      row.append(thumb, body, btnRemove);
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

  /**
   * Убрать изображение из очереди: строку списка, плашку и пузыри перевода.
   * Вызывающая сторона (injected.ts) исключает картинку из прогресса и
   * игнорирует уже запущенный для неё перевод.
   */
  removeImage(imageId: string) {
    this.rows.get(imageId)?.root.remove();
    this.rows.delete(imageId);
    this.labels.get(imageId)?.remove();
    this.labels.delete(imageId);
    this.clearBubbles(imageId);
    this.images = this.images.filter((img) => img.id !== imageId);
    this.cb.onRemoveImage(imageId);
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

  /**
   * Показать/скрыть все переводы: и тёмные плашки, и комикс-пузыри.
   * display у групп пузырей пересчитывает positionBubbles, поэтому здесь
   * переключаем флаг и гасим группы, а при показе просим пересчитать позиции.
   */
  private toggleLabels(btn: HTMLElement) {
    this.labelsVisible = !this.labelsVisible;
    this.bubblesVisible = this.labelsVisible;
    for (const label of this.labels.values()) label.style.display = this.labelsVisible ? 'block' : 'none';
    btn.textContent = this.labelsVisible ? i18n.t('overlay.clearLabels') : i18n.t('overlay.showLabels');
    if (this.labelsVisible) {
      this.repositionLabels();
      for (const imageId of this.bubbles.keys()) this.positionBubbles(imageId);
    } else {
      for (const entry of this.bubbles.values()) entry.group.style.display = 'none';
    }
  }

  /* ── мульти-выделение: накопление областей и результаты ──── */

  /** Отдать набранные области вызывающей стороне (одна пачка, один скриншот). */
  private translateSelected() {
    if (!this.regions.length || this.regionsBusy) return;
    this.regionsBusy = true;
    this.stopSelection();
    this.updateSelectionUI();
    // Блок держится до конца ВСЕЙ пачки: флаг снимаем в finally, а не по первой области.
    void (async () => {
      try {
        await this.cb.onRegionsSelected([...this.regions]);
      } finally {
        this.regionsBusy = false;
        this.updateSelectionUI();
      }
    })();
  }

  /** Сбросить всё выделение: контуры, плашки результатов, счётчик. */
  private clearRegions() {
    this.regions = [];
    // Токен гасит пачки в полёте: их плашки дропаются в injected по token.
    this.regionToken++;
    this.translatedRegions.clear();
    this.regionNodes.clear();
    this.regionMarks?.remove();
    this.regionMarks = undefined;
    for (const { el: plate } of this.regionPlates.values()) plate.remove();
    this.regionPlates.clear();
    this.cb.onRegionsCleared?.();
    this.updateSelectionUI();
  }

  /** Удалить одну область: контур, плашку результата и запись в списке. */
  removeRegion(id: string) {
    const index = this.regions.findIndex((r) => r.id === id);
    if (index === -1) return;
    const [gone] = this.regions.splice(index, 1);
    this.translatedRegions.delete(regionKey(gone));
    this.regionNodes.get(id)?.remove();
    this.regionNodes.delete(id);
    this.regionPlates.get(id)?.el.remove();
    this.regionPlates.delete(id);
    this.cb.onRegionRemoved?.(id);
    this.updateSelectionUI();
  }

  /** Убрать последнюю набранную область (кнопка «Отменить последнюю»). */
  private removeLastRegion() {
    const last = this.regions[this.regions.length - 1];
    if (last?.id) this.removeRegion(last.id);
  }

  private updateSelectionUI() {
    const count = this.regions.length;
    // Тот же ключ, что в injected: области без id считаются по координатам рамки.
    const remaining = this.regions.filter((r) => !this.translatedRegions.has(regionKey(r))).length;
    this.selCountEl.textContent = i18n.t('overlay.selectedCount', { count });
    this.btnUndoRegion.disabled = count === 0;
    // Всё переведено или идёт перевод — кнопку блокируем, иначе Enter дублирует пачку.
    this.btnTranslateSelected.disabled = count === 0 || this.regionsBusy || remaining === 0;
    this.btnClearSelection.disabled = count === 0;
    this.btnSelect.classList.toggle('active', this.selectionActive);
  }

  /**
   * Показать перевод поверх области выделения, в форме самой области.
   * Якорь хранится в координатах документа, поэтому плашка едет вместе со
   * страницей при скролле и живёт до «Очистить»/Esc, а не 15 секунд.
   */
  showRegionResult(region: SelectionRegion, text: string) {
    // id всегда есть (ставится при создании области): генерить новый тут нельзя,
    // иначе повторный показ той же области плодит плашки под разными ключами.
    const id = region.id ?? regionKey(region);
    this.regionPlates.get(id)?.el.remove();

    const b = region.bounds;
    // bounds уже документные — scroll не прибавляем, иначе скролл между
    // выделением и результатом сдвинет плашку на дельту (жалоба п.3).
    const anchor = { x: b.x, y: b.y, width: b.width, height: b.height };
    const shapeClass = region.shape === 'rectangle' ? 'rect' : region.shape;
    const plate = el('div', { class: `region-plate ${shapeClass}` });
    plate.append(el('span', { class: 'region-plate-text', text }));
    this.shadow.append(plate);
    this.regionPlates.set(id, { el: plate, anchor });
    this.positionRegionPlates();
  }

  /** Пересчёт позиций плашек областей; ушедшие за экран — скрыть. */
  private positionRegionPlates() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const { el: plate, anchor } of this.regionPlates.values()) {
      const left = anchor.x - window.scrollX;
      const top = anchor.y - window.scrollY;
      const offscreen = left + anchor.width < 0 || left > vw || top + anchor.height < 0 || top > vh;
      plate.style.display = offscreen ? 'none' : 'flex';
      if (offscreen) continue;
      plate.style.left = `${left}px`;
      plate.style.top = `${top}px`;
      plate.style.width = `${anchor.width}px`;
      plate.style.height = `${anchor.height}px`;
      const text = plate.firstElementChild as HTMLElement | null;
      if (text) fitBubbleText(plate, text, anchor.width, anchor.height);
    }
  }

  /** Слой контуров: SVG растянут на весь документ, координаты — документные. */
  private ensureMarkLayer(): SVGSVGElement {
    if (!this.regionMarks) {
      this.regionMarks = el('div', { class: 'region-marks' });
      const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
      this.regionMarks.append(svg);
      this.shadow.append(this.regionMarks);
    }
    return this.regionMarks.firstElementChild as SVGSVGElement;
  }

  /** Постоянный контур области: виден и без активного режима выделения. */
  private drawRegionMark(region: SelectionRegion) {
    const svg = this.ensureMarkLayer();
    // Координаты уже документные — прибавлять scroll больше не нужно.
    const b = region.bounds;
    let node: SVGElement;
    if (region.shape === 'oval') {
      node = document.createElementNS(SVG_NS, 'ellipse');
      node.setAttribute('cx', String(b.x + b.width / 2));
      node.setAttribute('cy', String(b.y + b.height / 2));
      node.setAttribute('rx', String(Math.max(1, b.width / 2)));
      node.setAttribute('ry', String(Math.max(1, b.height / 2)));
    } else if (region.shape === 'lasso' && region.points?.length) {
      node = document.createElementNS(SVG_NS, 'path');
      node.setAttribute('d', lassoPathData(region.points));
    } else {
      node = document.createElementNS(SVG_NS, 'rect');
      node.setAttribute('x', String(b.x));
      node.setAttribute('y', String(b.y));
      node.setAttribute('width', String(Math.max(1, b.width)));
      node.setAttribute('height', String(Math.max(1, b.height)));
    }
    node.setAttribute('class', 'region-mark');
    const id = region.id ?? `r${++this.regionSeq}`;
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = i18n.t('overlay.removeRegion');
    node.append(title);
    // Клик по контуру удаляет именно эту область (работает вне режима выделения).
    node.addEventListener('click', () => this.removeRegion(id));
    svg.append(node);
    this.regionNodes.set(id, node);
    this.positionRegionMarks();
  }

  /** Держать начало координат SVG в начале документа при скролле и ресайзе. */
  private positionRegionMarks() {
    if (!this.regionMarks) return;
    const svg = this.regionMarks.firstElementChild as SVGSVGElement;
    svg.setAttribute('width', String(Math.max(document.documentElement.scrollWidth, window.innerWidth)));
    svg.setAttribute('height', String(Math.max(document.documentElement.scrollHeight, window.innerHeight)));
    svg.style.left = `${-window.scrollX}px`;
    svg.style.top = `${-window.scrollY}px`;
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
    // bubbleShape: 'none' — пузыри не рисуем, перевод остаётся только на плашках.
    if (this.bubbleShape === 'none') return;

    const group = el('div', { class: 'bubbles' });
    group.dataset.imageId = imageId;
    const shapeClass = this.bubbleShape === 'rectangle' ? 'rect' : 'oval';
    for (const box of withText) {
      const bubble = el('div', { class: `bubble ${shapeClass}` });
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
    entry.group.style.display = this.bubblesVisible ? 'block' : 'none';

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
    // Клик по фигуре — это выбор инструмента: сразу входим в режим выделения,
    // иначе клик молча менял форму, а рисовать было нельзя (жалоба п.1).
    if (this.selectionActive) this.stopSelection();
    this.selShape = shape;
    for (const [id, btn] of this.shapeButtons) {
      btn.classList.toggle('active', id === shape);
    }
    this.startSelection();
    this.updateSelectionUI();
  }

  /* ── инструмент выделения (прямоугольник / овал / лассо) ──── */

  private startSelection() {
    if (this.selectionActive) return;
    this.selectionActive = true;
    this.updateSelectionUI();
    // Во время рисования старые контуры не перехватывают клики по слою выделения.
    this.regionMarks?.classList.remove('selectable');

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
      const captured = this.selShape === 'lasso' ? [...points, p] : [start, p];
      start = null;
      points = [];
      shapeEl.style.display = 'none';

      const viewport = boundsOf(captured);
      if (viewport.width < 8 || viewport.height < 8) return;

      // Храним в координатах документа: скролл между выделением и Enter
      // иначе кроп вырезает чужой кусок, а плашка съезжает (жалоба п.3).
      const dx = window.scrollX;
      const dy = window.scrollY;
      const bounds = {
        x: viewport.x + dx,
        y: viewport.y + dy,
        width: viewport.width,
        height: viewport.height,
      };
      const docPoints =
        this.selShape === 'lasso' ? captured.map((p) => ({ x: p.x + dx, y: p.y + dy })) : undefined;

      // Режим выделения не завершается после области: пользователь накидывает
      // несколько областей и переводит их пачкой (Enter / «Перевести выбранное»).
      const region: SelectionRegion = {
        id: `r${++this.regionSeq}`,
        shape: this.selShape,
        bounds,
        points: docPoints,
        token: this.regionToken,
      };
      this.regions.push(region);
      this.drawRegionMark(region);
      this.updateSelectionUI();
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
    // Вне режима выделения клик по контуру удаляет область.
    this.regionMarks?.classList.add('selectable');
    this.updateSelectionUI();
  }

  destroy() {
    this.stopSelection();
    this.clearRegions();
    this.clearBubbles();
    window.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('resize', this.onScroll);
    window.removeEventListener('keydown', this.onKeyDown);
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

/** Фокус в поле ввода? Тогда Enter не перехватываем (пользователь печатает на странице). */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

const OVERLAY_CSS = `
:host { all: initial; }
.panel {
  pointer-events: auto;
  z-index: 3;
  position: fixed; top: 12px; right: 12px; width: 380px; max-height: 70vh;
  display: flex; flex-direction: column;
  background: #ffffff; color: #1a1a1a;
  border: 1px solid #d0d0d0; border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.18);
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
/* flex-wrap обязателен: без переноса кнопки выдавливают ✕ за правый край экрана. */
.header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #eee; }
.title { font-weight: 600; margin-right: auto; min-width: 0; }
.btn {
  border: 1px solid #ccc; background: #f6f6f6; color: inherit; border-radius: 6px;
  padding: 4px 8px; font-size: 12px; cursor: pointer;
}
.btn:hover { background: #ececec; }
.btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
.btn.primary:hover { background: #1d4ed8; }
.btn.icon { padding: 2px 7px; flex: none; margin-left: auto; }
/* ✕ — убрать картинку из очереди: красный акцент, чтобы не спутать с кнопками панели. */
.btn.icon.remove { color: #b91c1c; }
.btn.icon.remove:hover { background: #fee2e2; border-color: #b91c1c; }
.shapes {
  display: flex; align-items: center; gap: 4px;
  padding: 6px 10px; border-bottom: 1px solid #f1f1f1;
}
.shapes-label { color: #666; font-size: 12px; margin-right: 2px; }
.btn.shape { padding: 2px 8px; font-size: 14px; line-height: 1.1; }
.btn.shape.active { background: #2563eb; border-color: #2563eb; color: #fff; }
.btn.active { background: #2563eb; border-color: #2563eb; color: #fff; }
.sel-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid #f1f1f1; }
.sel-count { color: #666; font-size: 12px; margin-right: auto; }
.btn:disabled { opacity: .5; cursor: default; }
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
.sel-layer { position: fixed; inset: 0; z-index: 1; cursor: crosshair; pointer-events: auto; background: rgba(37,99,235,.06); }
.sel-svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.sel-shape { fill: rgba(37,99,235,.12); stroke: #2563eb; stroke-width: 2; stroke-dasharray: 6 4; }

/* ── постоянные контуры выбранных областей (мульти-выделение) ── */
.region-marks { position: fixed; inset: 0; overflow: visible; pointer-events: none; z-index: 2; }
.region-marks svg { position: absolute; }
.region-mark { fill: rgba(37,99,235,.10); stroke: #2563eb; stroke-width: 2; }
/* Вне режима выделения клик по контуру удаляет область: подсвечиваем при наведении. */
.region-marks.selectable .region-mark { pointer-events: auto; cursor: pointer; }
.region-marks.selectable .region-mark:hover { fill: rgba(185,28,28,.18); stroke: #b91c1c; }

/* ── плашки перевода поверх областей (в форме выделения) ── */
.region-plate {
  position: fixed; z-index: 2;
  display: flex; align-items: center; justify-content: center;
  box-sizing: border-box; padding: 6px; overflow: hidden;
  background: #ffffff; color: #111111;
  border: 2px solid #2563eb; border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0,0,0,.22);
  text-align: center;
}
.region-plate.oval, .region-plate.lasso { border-radius: 50%; }
.region-plate-text {
  display: block; width: 100%;
  font: 13px/1.15 "Segoe UI", system-ui, sans-serif;
  font-weight: 600; letter-spacing: .01em;
  word-break: break-word; overflow-wrap: anywhere;
}

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
/* bubbleShape: 'rectangle' в настройках — скруглённый прямоугольник вместо овала. */
.bubble.rect { border-radius: 6px; }
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

