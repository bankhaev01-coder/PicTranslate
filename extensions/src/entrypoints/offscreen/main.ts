/**
 * Offscreen-документ (reason в манифесте: WORKERS) — полностью локальный
 * OCR + NMT конвейер для engine:'local'. Без бэкенда, ключей и Docker.
 *
 * Маршрутизация сообщений: здесь обрабатываются только сообщения с
 * target:'offscreen'; background-сервис-воркер их игнорирует и наоборот.
 */
import i18n, { initI18n } from '@/lib/i18n';
import { browser } from 'wxt/browser';
import { getSettings } from '@/lib/storage';
import { getVendorManifest } from '@/lib/local/vendor';
import { localCacheClear, localCacheGet, localCacheSet, sha256Hex } from '@/lib/local/localCache';
import { grayscaleInPlace } from '@/lib/local/preprocess';
import { chunkText, isMostlyCyrillic, pickPair } from '@/lib/local/text';
import { listPairs } from '@/lib/local/registry';
import { recognizeText } from '@/lib/local/ocr';
import { sendNativeMessage } from '@/lib/native/nativeClient';
import { MtClient } from '@/lib/local/mtClient';
import type { Msg, TranslateResult } from '@/lib/types';

await initI18n();

const mt = new MtClient();

browser.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if ((msg as { target?: string }).target !== 'offscreen') return false;
  handle(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String(e) }));
  return true;
});

async function handle(msg: Msg): Promise<unknown> {
  switch (msg.type) {
    case 'TRANSLATE_LOCAL':
      return localPipeline(msg.dataUrl, msg.regionOnly);

    case 'LOCAL_CACHE_CLEAR':
      await localCacheClear();
      return { ok: true };

    default:
      return undefined;
  }
}

/* ── локальный OCR + NMT конвейер ───────────────────────────────────────── */

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
}

/** Декод → оттенки серого (паритет с backend _preprocess) → текст tesseract. */
async function ocrFromDataUrl(
  dataUrl: string,
  langs: string[],
  vendor: Awaited<ReturnType<typeof getVendorManifest>>,
): Promise<string> {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  grayscaleInPlace(imageData.data);
  ctx.putImageData(imageData, 0, 0);
  return recognizeText(canvas, langs, vendor);
}

async function localPipeline(dataUrl: string, regionOnly: boolean): Promise<TranslateResult> {
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const settings = await getSettings();
  const vendor = await getVendorManifest();

  const bytes = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
  const hash = await sha256Hex(bytes);
  const scope = regionOnly ? 'reg' : 'full';
  const cacheId = `${settings.targetLang}:${settings.sourceLang}:${settings.ocrLangs.join('+')}:${hash}`;

  const cached = await localCacheGet<TranslateResult>(scope, cacheId);
  if (cached) return cached;

  const fail = (error: string, source = ''): TranslateResult => ({
    source_text: source,
    translation: '',
    model: 'local',
    latency_ms: elapsed(),
    error,
  });

  const hasTesseractPack = Boolean(vendor?.tesseract && vendor.baseUrl);
  // Native host может заменять вендор-пак tesseract-воркера.
  if (!hasTesseractPack && !settings.useNativeHost) {
    return fail('offline asset pack is missing: run npm run vendor and rebuild the extension');
  }
  if (!vendor?.pairs.length) {
    return fail('offline translation model pack is missing: run npm run vendor and rebuild the extension');
  }

  // 1) OCR — либо встроенный tesseract-воркер, либо native host.
  let sourceText = '';
  const langs = settings.ocrLangs.length ? settings.ocrLangs : ['eng'];
  try {
    if (settings.useNativeHost) {
      const native = await sendNativeMessage({ action: 'ocr', image_base64: dataUrl, langs });
      if (!native.ok) {
        return fail(`Native OCR: ${native.error ?? 'host did not respond'}`);
      }
      sourceText = (native.source_text ?? '').trim();
    } else {
      sourceText = await ocrFromDataUrl(dataUrl, langs, vendor);
    }
  } catch (e) {
    return fail(`OCR: ${String(e)}`);
  }
  if (!sourceText) {
    return { source_text: '', translation: '', model: 'local', boxes: [], latency_ms: elapsed() };
  }

  const detected = isMostlyCyrillic(sourceText) ? 'ru' : 'en';

  // 2) Выбор направления MT
  const available = listPairs().map((p) => p.id);
  const downloaded = vendor.pairs;
  const pick = pickPair(
    {
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      text: sourceText,
      preferred: settings.mtPair,
      available,
    },
    downloaded,
  );

  if (pick.passthrough) {
    const passthrough: TranslateResult = {
      source_text: sourceText,
      translation: sourceText,
      model: 'local:passthrough',
      detected_language: detected,
      boxes: [],
      latency_ms: elapsed(),
    };
    await localCacheSet(scope, cacheId, passthrough);
    return passthrough;
  }
  if (!pick.pair) {
    return fail(i18n.t('local.errPairMissing', { pair: pick.missingPair ?? '?' }), sourceText);
  }

  // 3) NMT (модель загружается только из встроенного офлайн-пака ассетов).
  try {
    await mt.ensurePair(pick.pair, vendor);
  } catch (e) {
    return fail(`${i18n.t('local.errModelLoad')}: ${String((e as Error).message ?? e)}`, sourceText);
  }

  try {
    const chunks = chunkText(sourceText);
    const parts: string[] = [];
    for (const chunk of chunks) {
      parts.push(await mt.translate(pick.pair, chunk));
    }
    const result: TranslateResult = {
      source_text: sourceText,
      translation: parts.join('\n'),
      model: `local:${pick.pair}`,
      detected_language: detected,
      boxes: [],
      latency_ms: elapsed(),
    };
    await localCacheSet(scope, cacheId, result);
    return result;
  } catch (e) {
    return fail(`${i18n.t('local.errMtFailed')}: ${String((e as Error).message ?? e)}`, sourceText);
  }
}
