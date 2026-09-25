import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { browser } from 'wxt/browser';
import { getSettings } from '@/lib/storage';
import { initI18n } from '@/lib/i18n';
import { TRANSLATE_CONCURRENCY } from '@/lib/constants';
import { OverlayUI } from '@/lib/overlay';
import { cropRegion, fetchImageBlob, scanImages } from '@/lib/scanner';
import { blobToDataUrl, sendToBackground } from '@/lib/messaging';
import type {
  CaptureVisibleResponse,
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

  /* ── сообщения из popup / background ── */
  browser.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
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
    await initI18n();
    const settings = await getSettings();
    const images = scanImages(settings.minImageSize);

    closeOverlay();
    overlay = new OverlayUI({
      onTranslate: (imgs) => void translateAll(imgs),
      onRegion: (region) => void translateRegion(region),
      onClose: () => closeOverlay(),
    });
    overlay.setImages(images);
    return images;
  }

  function closeOverlay() {
    overlay?.destroy();
    overlay = null;
  }

  /* ── перевод всех изображений (ограниченная параллельность) ── */
  async function translateAll(images: PageImage[]) {
    const queue = [...images];
    const total = queue.length;
    let done = 0;

    const workers = Array.from(
      { length: Math.max(1, Math.min(TRANSLATE_CONCURRENCY, total)) },
      () => runWorker(),
    );
    await Promise.all(workers);

    async function runWorker() {
      for (;;) {
        const img = queue.shift();
        if (!img) return;
        overlay?.setStatus(img.id, 'working', undefined, done, total);

        const result = await translateOne(img);
        done += 1;
        overlay?.setStatus(img.id, result.error ? 'error' : 'done', result, done, total);
      }
    }
  }

  async function translateOne(img: PageImage): Promise<TranslateResult> {
    const blob = await fetchImageBlob(img.src);
    if (!blob) {
      return {
        source_text: '',
        translation: '',
        model: 'n/a',
        latency_ms: 0,
        error: 'Image is not readable (CORS/blocked). Use "Translate visible area".',
      };
    }
    const dataUrl = await blobToDataUrl(blob);
    const res = await sendToBackground<TranslateResult>({
      type: 'TRANSLATE_DATA_URL',
      imageId: img.id,
      dataUrl,
    });
    // Комикс-пузыри для каждого найденного речевого пузыря на этом изображении.
    if (res.boxes?.length) overlay?.showBubbles(img.id, res.boxes);
    return res;
  }

  /* ── инструмент выделения: обрезать скриншот и перевести заново область ── */
  async function translateRegion(region: SelectionRegion) {
    await initI18n();
    const cap = await sendToBackground<CaptureVisibleResponse>({ type: 'CAPTURE_VISIBLE' });
    if (!cap.dataUrl) {
      overlay?.showRegionResult(region, `⚠ ${cap.error ?? 'capture failed'}`);
      return;
    }

    try {
      // Маскирование формой выполняется на скриншоте, чтобы графический шум
      // вокруг текста (ары фона, рамки панелей) не доходил до OCR/vision-модели.
      const blob = await cropRegion(cap.dataUrl, region);
      const dataUrl = await blobToDataUrl(blob);
      const res = await sendToBackground<TranslateResult>({
        type: 'TRANSLATE_DATA_URL',
        imageId: 'region',
        dataUrl,
        regionOnly: true,
      });
      overlay?.showRegionResult(region, res.error ? `⚠ ${res.error}` : res.translation || '—');
    } catch (e) {
      overlay?.showRegionResult(region, `⚠ ${String(e)}`);
    }
  }
});
