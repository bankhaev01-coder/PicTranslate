import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { browser } from 'wxt/browser';
import { getSettings } from '@/lib/storage';
import { initI18nFromSettings } from '@/lib/i18n';
import { runConcurrent } from '@/lib/queue';
import { OverlayUI } from '@/lib/overlay';
import { regionKey } from '@/lib/selection';
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
  /** Поколение выделения: Esc/«Очистить»/новый скан гасят прилетевшие позже плашки. */
  let batchToken = 0;
  /** Изображения текущей сессии — для пересчёта прогресса при удалении. */
  let sessionImages: PageImage[] = [];

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
    if (msg.type === 'CLEAR_OVERLAY') {
      closeOverlay();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  async function scanAndShow(): Promise<PageImage[]> {
    await initI18nFromSettings();
    const settings = await getSettings();
    const images = scanImages(settings.minImageSize);

    closeOverlay();
    removed.clear();
    doneIds.clear();
    translatedRegions.clear();
    // Новый скан — новое поколение: пачки в полёте от старого оверлея дропаются.
    batchToken++;
    sessionImages = images;
    overlay = new OverlayUI(
      {
        onTranslate: (imgs) => void translateAll(imgs),
        onRegionsSelected: (regions) => void translateRegions(regions),
        onRemoveImage: (id) => {
          // Уже переведённая картинка больше не участвует в прогрессе.
          removed.add(id);
          syncProgress();
        },
        // Удалённую область переведённой не считаем: заново обвёл — переведи.
        onRegionRemoved: (id) => translatedRegions.delete(id),
        onRegionsCleared: () => {
          translatedRegions.clear();
          batchToken++;
        },
        onClose: () => closeOverlay(),
      },
      settings.bubbleShape,
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
    const settings = await getSettings();
    /** Активные = не убранные пользователем из очереди. */
    const activeIds = () => images.filter((img) => !removed.has(img.id));
    const progress = () => ({
      done: [...doneIds].filter((id) => !removed.has(id)).length,
      total: activeIds().length,
    });

    const finish = (img: PageImage, result: TranslateResult) => {
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
        if (removed.has(img.id)) return;
        const { done, total } = progress();
        overlay?.setStatus(img.id, 'working', undefined, done, total);
        finish(img, await translateOne(img));
      },
      // Падение одной картинки не обрывает очередь: помечаем её ошибкой
      // и продолжаем переводить остальные.
      (img, _index, error) => finish(img, failedResult(error)),
      // Убранные из очереди картинки не запускаются и не считаются ошибками.
      (img) => removed.has(img.id),
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
    // Комикс-пузыри — только если картинку не убрали из очереди за время запроса.
    if (res.boxes?.length && !removed.has(img.id)) overlay?.showBubbles(img.id, res.boxes);
    return res;
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
  async function translateRegions(regions: SelectionRegion[]) {
    if (!regions.length) return;
    // Повторный Enter переводит только несделанное: готовые области
    // пропускаем, иначе пачка уходит на сервер заново (жалоба п.2).
    const pending = regions.filter((r) => !translatedRegions.has(regionKey(r)));
    if (!pending.length) return;
    const settings = await getSettings();
    const cap = await sendToBackground<CaptureVisibleResponse>({ type: 'CAPTURE_VISIBLE' });
    if (!cap.dataUrl) {
      const text = `⚠ ${cap.error ?? 'capture failed'}`;
      for (const region of pending) {
        if (region.token !== batchToken) continue;
        overlay?.showRegionResult(region, text);
      }
      return;
    }
    const shot = cap.dataUrl;
    // Скролл на момент скриншота: кроп вычитает его из документных координат.
    const scrollAtCapture = { x: window.scrollX, y: window.scrollY };
    // Токен пачки: Esc/«Очистить»/новый скан во время перевода — прилетевшие
    // позже плашки дропаются, а не всплывают на сброшенное выделение.
    const token = batchToken;

    // Одно CAPTURE_VISIBLE на пачку: все области вырезаются из одного кадра,
    // поэтому N выделений стоят один скриншот, а не N.
    await runConcurrent(
      pending,
      settings.translateConcurrency ?? 1,
      async (region) => {
        // Маскирование формой выполняется на скриншоте, чтобы графический шум
        // вокруг текста (ары фона, рамки панелей) не доходил до OCR/vision-модели.
        const blob = await cropRegion(shot, region, scrollAtCapture);
        const dataUrl = await blobToDataUrl(blob);
        const res = await sendToBackground<TranslateResult>({
          type: 'TRANSLATE_DATA_URL',
          imageId: region.id ?? 'region',
          dataUrl,
          regionOnly: true,
        });
        if (region.token !== token) return;
        const failed = Boolean(res.error);
        if (!failed) translatedRegions.add(regionKey(region));
        overlay?.showRegionResult(region, res.error ? `⚠ ${res.error}` : res.translation || '—');
      },
      (region, error) => {
        if (region.token !== token) return;
        overlay?.showRegionResult(region, `⚠ ${String(error)}`);
      },
    );
  }
});
