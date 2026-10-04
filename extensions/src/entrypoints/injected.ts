import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { browser } from 'wxt/browser';
import { getSettings } from '@/lib/storage';
import { initI18nFromSettings } from '@/lib/i18n';
import { runConcurrent } from '@/lib/queue';
import { createJobQueue } from '@/lib/jobQueue';
import { OverlayUI } from '@/lib/overlay';
import { regionKey } from '@/lib/selection';
import { readViewportFrame, dataUrlImageSize, translateViewport } from '@/lib/viewportTranslation';
import { cropRegion, fetchImageBlob, scanImages, type ImageFetchResult } from '@/lib/scanner';
import { blobToDataUrl, sendToBackground } from '@/lib/messaging';
import type {
  CaptureVisibleResponse,
  ContentMsg,
  Msg,
  PageImage,
  SelectionRegion,
  TranslateResult,
} from '@/lib/types';

/**
 * Внедряется по запросу через chrome.scripting.executeScript (activeTab) —
 * расширение НЕ запрашивает host-разрешение <all_urls> и не регистрирует
 * статический контент-скрипт, поэтому предупреждение при установке минимально.
 */
export default defineUnlistedScript(() => {
  let overlay: OverlayUI | null = null;
  /** Изображения, убранные пользователем из очереди (в рамках текущего скана). */
  const removed = new Set<string>();
  /** Изображения, перевод которых уже завершён (успех или ошибка). */
  const doneIds = new Set<string>();
  /** Области выделения, переведённые успешно: повторный Enter их пропускает. */
  const translatedRegions = new Set<string>();
  /**
   * Crops of selected regions (key: generation + region): captured while the
   * area is on screen, so translation and retries do not need it visible.
   */
  const regionCrops = new Map<string, string>();
  /** Regions queued or in flight: dedup for repeated Enter / double click. */
  const regionInFlight = new Set<string>();
  /** Поколение выделения: Esc/«Очистить»/новый скан гасят прилетевшие позже плашки. */
  let batchToken = 0;
  /** Изображения текущей сессии — для пересчёта прогресса при удалении. */
  let sessionImages: PageImage[] = [];
  let viewportRequest = 0;
  let imageRequest = 0;

  /** Прогресс «переведено X из Y» без учёта убранных из очереди картинок. */
  function syncProgress() {
    const done = [...doneIds].filter((id) => !removed.has(id)).length;
    const total = sessionImages.filter((img) => !removed.has(img.id)).length;
    overlay?.setProgress(done, total);
  }

  /* ── сообщения из popup / background ── */
  browser.runtime.onMessage.addListener((msg: Msg | ContentMsg, _sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'SCAN_IMAGES') {
      scanAndShow()
        .then((images) => sendResponse({ ok: true, count: images.length }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg.type === 'TRANSLATE_VIEWPORT') {
      translateVisibleArea().then(sendResponse).catch(e => sendResponse(failedResult(e)));
      return true;
    }
    if (msg.type === 'CLEAR_OVERLAY') {
      // Только скрыть панель: контуры, плашки и пузыри остаются на странице.
      overlay?.hidePanel();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'SET_UI_HIDDEN') {
      overlay?.setCaptureHidden(msg.hidden);
      // При скрытии дожидаемся перерисовки: иначе captureVisibleTab может
      // поймать старый кадр с панелью.
      const wait = msg.hidden ? nextPaint() : Promise.resolve();
      void wait.then(() => sendResponse({ ok: true }));
      return true;
    }
    return false;
  });

  async function scanAndShow(): Promise<PageImage[]> {
    await initI18nFromSettings();
    const settings = await getSettings();
    const images = scanImages(settings.minImageSize);

    closeOverlay();
    viewportRequest++;
    imageRequest++;
    removed.clear();
    doneIds.clear();
    translatedRegions.clear();
    regionCrops.clear();
    // Новый скан — новое поколение: пачки в полёте от старого оверлея дропаются.
    batchToken++;
    sessionImages = images;
    overlay = new OverlayUI(
      {
        onTranslate: (imgs) => void translateAll(imgs),
        // Промис возвращаем в overlay: он держит регион-кнопку заблокированной до
        // конца всей пачки. С `void` finally срабатывает сразу — второй Enter во
        // время полёта запускал дублирующий capture+OCR+MT (регрессия E2E).
        // A region was just selected - queue it right away: the snapshot is
        // taken on the spot, the page can be scrolled afterwards.
        onRegionSelected: (region) => void queueRegion(region),
        onRegionsSelected: (regions) => translateRegions(regions),
        onRemoveImage: (id) => {
          // Уже переведённая картинка больше не участвует в прогрессе.
          removed.add(id);
          syncProgress();
        },
        // Удалённую область переведённой не считаем: заново обвёл — переведи.
        onRegionRemoved: (id) => {
          translatedRegions.delete(id);
          // The crop of a cancelled region is no longer needed.
          regionCrops.delete(`${batchToken}:${id}`);
        },
        onRegionsCleared: () => {
          translatedRegions.clear();
          regionCrops.clear();
          batchToken++;
        },
      },
      settings.bubbleShape,
      // Текущее поколение из injected: области штампуются batchToken, иначе
      // результаты пачки дропаются в translateRegions как устаревшие (E2E-регрессия).
      batchToken,
    );
    overlay.setImages(images);
    return images;
  }

  function closeOverlay() {
    overlay?.destroy();
    overlay = null;
  }

  /* ── перевод всех изображений (очередь с параллельностью из настроек) ── */
  async function translateAll(images: PageImage[]) {
    const request = ++imageRequest;
    const owner = overlay;
    const settings = await getSettings();
    const isCurrent = () => request === imageRequest && owner === overlay;
    /** Активные = не убранные пользователем из очереди. */
    const activeIds = () => images.filter((img) => !removed.has(img.id));
    const progress = () => ({
      done: [...doneIds].filter((id) => !removed.has(id)).length,
      total: activeIds().length,
    });

    const finish = (img: PageImage, result: TranslateResult) => {
      if (!isCurrent()) return;
      doneIds.add(img.id);
      if (removed.has(img.id)) {
        syncProgress();
        return;
      }
      const { done, total } = progress();
      overlay?.setStatus(img.id, result.error ? 'error' : 'done', result, done, total);
    };

    await runConcurrent(
      images,
      settings.translateConcurrency ?? 1,
      async (img) => {
        if (!isCurrent() || removed.has(img.id)) return;
        const { done, total } = progress();
        overlay?.setStatus(img.id, 'working', undefined, done, total);
        finish(img, await translateOne(img));
      },
      // Падение одной картинки не обрывает очередь: помечаем её ошибкой
      // и продолжаем переводить остальные.
      (img, _index, error) => finish(img, failedResult(error)),
      // Убранные из очереди картинки не запускаются и не считаются ошибками.
      (img) => !isCurrent() || removed.has(img.id),
    );
  }

  /** Результат-заглушка для необработанного исключения в очереди. */
  function failedResult(error: unknown): TranslateResult {
    return {
      source_text: '',
      translation: '',
      model: 'n/a',
      latency_ms: 0,
      error: String(error),
    };
  }

  async function translateOne(img: PageImage): Promise<TranslateResult> {
    const loaded = await fetchImageBlob(img.src);
    if (!loaded.ok) {
      return {
        source_text: '',
        translation: '',
        model: 'n/a',
        latency_ms: 0,
        error: imageFetchError(loaded),
      };
    }
    const dataUrl = await blobToDataUrl(loaded.blob);
    const res = await sendToBackground<TranslateResult>({
      type: 'TRANSLATE_DATA_URL',
      imageId: img.id,
      dataUrl,
    });
    return res;
  }

  async function translateVisibleArea(): Promise<TranslateResult> {
    if (!overlay) await scanAndShow();
    const request = ++viewportRequest;
    const owner = overlay;
    const generation = imageRequest;
    return translateViewport({
      frame: readViewportFrame,
      capture: captureSerialized,
      size: dataUrlImageSize,
      translate: dataUrl => sendToBackground<TranslateResult>({
        type: 'TRANSLATE_DATA_URL', imageId: `viewport-${request}`, dataUrl, regionOnly: false,
      }),
      isCurrent: () => request === viewportRequest && generation === imageRequest && overlay === owner,
      render: (frame, size, result) => owner?.showViewportResult(frame, size, result),
    });
  }

  /**
   * Человекочитаемая причина сбоя загрузки. Для CORS-ошибок статус (403/429)
   * скрыт браузером — подробности см. в консоли страницы по метке [translate-ext DIAG].
   */
  function imageFetchError(f: Extract<ImageFetchResult, { ok: false }>): string {
    if (f.kind === 'http') {
      return `Image rejected by the server (HTTP ${f.status}). Retry later or use "Translate visible area".`;
    }
    return 'Image is not readable (CORS/blocked or CDN rate limit). Use "Translate visible area" — details in the page console under [translate-ext DIAG].';
  }

  /* ── выделение: один скриншот на пачку, кроп и перевод каждой области ── */
  /** Дождаться двух кадров (fallback — 80 мс): скриншот снимается после перерисовки. */
  function nextPaint(): Promise<void> {
    return Promise.race([
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
      new Promise<void>((resolve) => window.setTimeout(resolve, 80)),
    ]);
  }

  /** Скрыть нашу разметку на время скриншота и показать обратно (finally). */
  async function captureWithoutUi(): Promise<CaptureVisibleResponse> {
    overlay?.setCaptureHidden(true);
    try {
      await nextPaint();
      return await sendToBackground<CaptureVisibleResponse>({ type: 'CAPTURE_VISIBLE' });
    } finally {
      overlay?.setCaptureHidden(false);
    }
  }

  /** Snapshots strictly one at a time: overlapping hide/show would capture a foreign frame. */
  let captureChain: Promise<unknown> = Promise.resolve();
  function captureSerialized(): Promise<CaptureVisibleResponse> {
    const run = captureChain.then(() => captureWithoutUi());
    captureChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Crop/task key: generation + region. Region ids restart on a new scan (a
   * fresh OverlayUI), so without the generation the keys of different scans
   * would collide and cache/dedup would silently drop jobs.
   */
  function regionJobKey(region: SelectionRegion): string {
    return `${region.token}:${regionKey(region)}`;
  }

  /**
   * Region translation queue: the crop was taken at selection time, here only
   * the engine request goes out - one shared translateConcurrency limit for
   * all batches. A result is dropped by the generation token (Esc/Clear/new
   * scan while the job was queued).
   */
  const regionQueue = createJobQueue<{ key: string; region: SelectionRegion; dataUrl: string }>(
    1,
    async ({ key, region, dataUrl }) => {
      try {
        const res = await sendToBackground<TranslateResult>({
          type: 'TRANSLATE_DATA_URL',
          imageId: region.id ?? 'region',
          dataUrl,
          regionOnly: true,
        });
        if (region.token !== batchToken) return;
        const failed = Boolean(res.error);
        if (!failed) translatedRegions.add(regionKey(region));
        overlay?.showRegionResult(
          region,
          res.error ? `\u26A0 ${res.error}` : res.translation || '\u2014',
          !failed,
        );
      } catch (error) {
        if (region.token !== batchToken) return;
        overlay?.showRegionResult(region, `\u26A0 ${String(error)}`, false);
      } finally {
        regionInFlight.delete(key);
      }
    },
  );

  /** Push a crop into the queue (a repeat for the same region is ignored). */
  function pushRegionJob(region: SelectionRegion, dataUrl: string) {
    const key = regionJobKey(region);
    if (regionInFlight.has(key)) return;
    regionInFlight.add(key);
    regionQueue.push({ key, region, dataUrl });
  }

  /** Cut the region out of the frame and store the crop for its generation. */
  async function cropAndCache(
    region: SelectionRegion,
    shot: string,
    scroll: { x: number; y: number },
  ): Promise<string> {
    const blob = await cropRegion(shot, region, scroll);
    const dataUrl = await blobToDataUrl(blob);
    regionCrops.set(regionJobKey(region), dataUrl);
    return dataUrl;
  }

  /**
   * Region selected - queue it right away: the frame is captured on the spot
   * while the area is on screen, the crop is cached and the translation runs
   * in the background. After mouseup the page can be scrolled - this area will
   * not be part of any later frame.
   */
  async function queueRegion(region: SelectionRegion): Promise<void> {
    try {
      const cap = await captureSerialized();
      // Esc/Clear/new scan while the snapshot was in flight - drop the job.
      if (region.token !== batchToken) return;
      if (!cap.dataUrl) {
        overlay?.showRegionResult(region, `\u26A0 ${cap.error ?? 'capture failed'}`, false);
        return;
      }
      // Scroll is read right after the snapshot response - closest to the frame.
      const scrollAtCapture = { x: window.scrollX, y: window.scrollY };
      const dataUrl = await cropAndCache(region, cap.dataUrl, scrollAtCapture);
      const settings = await getSettings();
      regionQueue.setLimit(settings.translateConcurrency ?? 1);
      pushRegionJob(region, dataUrl);
    } catch (e) {
      if (region.token !== batchToken) return;
      overlay?.showRegionResult(region, `\u26A0 ${String(e)}`, false);
    }
  }

  /**
   * Re-order via button/Enter: translates regions that are not done yet.
   * Fresh ones already sit in the queue as crops (taken at selection) and are
   * not pushed twice (regionInFlight); regions without a frame (snapshot failed
   * at selection / manual retry) get one shared snapshot for the whole batch.
   */
  async function translateRegions(regions: SelectionRegion[]) {
    if (!regions.length) return;
    // A repeat Enter only translates what is not done: finished regions are
    // skipped, otherwise the batch would hit the server again (complaint p.2).
    const pending = regions.filter((r) => !translatedRegions.has(regionKey(r)));
    if (!pending.length) return;
    const token = batchToken;
    const settings = await getSettings();
    regionQueue.setLimit(settings.translateConcurrency ?? 1);

    const showFor = (list: SelectionRegion[], text: string) => {
      for (const region of list) {
        if (region.token === token) overlay?.showRegionResult(region, text, false);
      }
    };

    // Regions without a frame: the snapshot failed at selection time or a
    // manual retry - one shared snapshot for them, as before.
    const withoutCrop = pending.filter((r) => !regionCrops.has(regionJobKey(r)));
    if (withoutCrop.length) {
      let shot: string | null = null;
      try {
        const cap = await captureSerialized();
        shot = cap.dataUrl ?? null;
        if (!shot) showFor(withoutCrop, `\u26A0 ${cap.error ?? 'capture failed'}`);
      } catch (e) {
        showFor(withoutCrop, `\u26A0 ${String(e)}`);
      }
      if (shot) {
        // Scroll at snapshot time: the crop subtracts it from document coords.
        const scrollAtCapture = { x: window.scrollX, y: window.scrollY };
        for (const region of withoutCrop) {
          if (region.token !== token) continue;
          try {
            await cropAndCache(region, shot, scrollAtCapture);
          } catch (e) {
            overlay?.showRegionResult(region, `\u26A0 ${String(e)}`, false);
          }
        }
      }
    }

    for (const region of pending) {
      if (region.token !== token) continue;
      const dataUrl = regionCrops.get(regionJobKey(region));
      if (dataUrl) pushRegionJob(region, dataUrl);
    }
    // The batch promise for overlay: regionsBusy holds until the queue drains.
    await regionQueue.drain();
  }
});
