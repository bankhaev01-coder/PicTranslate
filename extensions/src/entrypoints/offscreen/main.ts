/**
 * Offscreen-документ (reason в манифесте: WORKERS) — полностью локальный
 * OCR + NMT конвейер для engine:'local'. Без бэкенда, ключей и Docker.
 *
 * Маршрутизация сообщений: здесь обрабатываются только сообщения с
 * target:'offscreen'; background-сервис-воркер их игнорирует и наоборот.
 */
import i18n, { initI18n } from '@/lib/i18n';
import { browser } from 'wxt/browser';
import { getVendorManifest } from '@/lib/local/vendor';
import { buildLocalCacheKey, localCacheClear, localCacheGet, localCacheSet, sha256Hex } from '@/lib/local/localCache';
import { computePad, grayscaleInPlace, upscaleToMinTextHeight } from '@/lib/local/preprocess';
import { chunkText, isMostlyCyrillic, joinOcrLines, pickPair } from '@/lib/local/text';
import { listPairs } from '@/lib/local/registry';
import { translateLongText, type MtProvider } from '@/lib/local/externalMt';
import { recognizeBest, type OcrResult } from '@/lib/local/ocr';
import { parseImageOcr } from '@/lib/local/parseImage';
import { sendNativeMessage } from '@/lib/native/nativeClient';
import { MtClient } from '@/lib/local/mtClient';
import type { Box, LocalEngineSettings, Msg, TranslateResult } from '@/lib/types';

// Регистрация слушателя синхронно на верхнем уровне, чтобы избежать гонки
// с createDocument() в service worker ("Receiving end does not exist").
let i18nReady = false;
const i18nPromise = initI18n()
  .then(() => {
    i18nReady = true;
  })
  .catch((e) => {
    // Не оставляем необработанный rejection: PING должен отвечать и без i18n.
    console.error('[offscreen] i18n init failed', e);
  });

const mt = new MtClient();

browser.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if ((msg as { target?: string }).target !== 'offscreen') return false;

  if (msg.type === 'PING') {
    sendResponse({ ok: true });
    return true;
  }

  // Для остальных команд дожидаемся готовности переводов i18n
  (async () => {
    if (!i18nReady) await i18nPromise;
    return handle(msg);
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String(e) }));

  return true;
});

async function handle(msg: Msg): Promise<unknown> {
  switch (msg.type) {
    case 'TRANSLATE_LOCAL':
      return localPipeline(msg.settings, msg.dataUrl, msg.regionOnly);

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

/** Целевая меньшая сторона канвы перед OCR по качеству (fast/balanced/best):
 * мелкий текст манги читается заметно лучше после ×2–×4. */
const OCR_UPSCALE_MIN: Record<LocalEngineSettings['ocrQuality'], number> = {
  fast: 300,
  balanced: 500,
  best: 800,
};

/**
 * Декод → апскейл при малом размере → белая рамка → оттенки серого →
 * многопроходный OCR. Варианты предобработки и режимы сегментации подбирает
 * recognizeBest по качеству OCR из настроек (fast/balanced/best).
 */
async function ocrFromDataUrl(
  dataUrl: string,
  langs: string[],
  vendor: Awaited<ReturnType<typeof getVendorManifest>>,
  settings: LocalEngineSettings,
  regionOnly: boolean,
): Promise<OcrResult> {
  const img = await loadImage(dataUrl);
  let canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { text: '', boxes: [], confidence: 0 };
  ctx.drawImage(img, 0, 0);

  // Апскейл, если размер canvas слишком мал для надежного чтения текста.
  const origW = canvas.width;
  const minSide = OCR_UPSCALE_MIN[settings.ocrQuality ?? 'balanced'] ?? 300;
  canvas = upscaleToMinTextHeight(canvas, minSide);
  const scaleRatio = canvas.width / origW;

  // Белая рамка по краям: LSTM точнее читает текст, не упирающийся в край
  // кропа (при выделении рамкой так почти всегда). Координаты боксов потом
  // сдвигаются обратно на pad.
  const pad = computePad(canvas.width, canvas.height);
  if (pad > 0) {
    const padded = document.createElement('canvas');
    padded.width = canvas.width + pad * 2;
    padded.height = canvas.height + pad * 2;
    const pctx = padded.getContext('2d');
    if (pctx) {
      pctx.fillStyle = '#ffffff';
      pctx.fillRect(0, 0, padded.width, padded.height);
      pctx.drawImage(canvas, pad, pad);
      canvas = padded;
    }
  }

  const ctx2 = canvas.getContext('2d');
  if (!ctx2) return { text: '', boxes: [], confidence: 0 };
  const imageData = ctx2.getImageData(0, 0, canvas.width, canvas.height);

  // Оттенки серого — общая база для всех вариантов предобработки.
  grayscaleInPlace(imageData.data);
  ctx2.putImageData(imageData, 0, 0);

  const res = await recognizeBest(canvas, langs, vendor, {
    quality: settings.ocrQuality,
    minConfidence: settings.ocrMinConfidence ?? 40,
    regionOnly,
  });

  // Боксы возвращаем в исходный масштаб изображения: сначала снимаем рамку,
  // затем — апскейл.
  if (res.boxes.length && (scaleRatio !== 1 || pad > 0)) {
    res.boxes = res.boxes.map((b) => ({
      ...b,
      x: Math.max(0, Math.round((b.x - pad) / scaleRatio)),
      y: Math.max(0, Math.round((b.y - pad) / scaleRatio)),
      width: Math.round(b.width / scaleRatio),
      height: Math.round(b.height / scaleRatio),
    }));
  }

  return res;
}

async function localPipeline(
  settings: LocalEngineSettings,
  dataUrl: string,
  regionOnly: boolean,
): Promise<TranslateResult> {
  // Настройки приходят из background: в offscreen недоступен chrome.storage.
  await initI18n(settings.uiLang);
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const vendor = await getVendorManifest();

  const bytes = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
  const hash = await sha256Hex(bytes);
  // Ключ включает провайдера MT и настройки OCR: смена любого из них даёт
  // другой ключ, и пользователь не получит чужой/устаревший результат.
  const { scope, cacheId } = buildLocalCacheKey({
    imageHash: hash,
    regionOnly,
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    ocrLangs: settings.ocrLangs,
    ocrQuality: settings.ocrQuality,
    ocrMinConfidence: settings.ocrMinConfidence,
    useNativeHost: settings.useNativeHost,
    cloudOcr: settings.cloudOcr,
    cloudTranslate: settings.cloudTranslate,
    externalMt: settings.externalMt,
    externalMtPriority: settings.externalMtPriority,
  });

  const cached = await localCacheGet<TranslateResult>(scope, cacheId);
  if (cached) return cached;

  const fail = (error: string, source = ''): TranslateResult => ({
    source_text: source,
    translation: '',
    model: 'local',
    latency_ms: elapsed(),
    error,
  });

  // 1) Облачный OCR выделенной области — способ uLanguage (backenster
  //    parseImage): сервер отдаёт строки без bbox, поэтому только regionOnly.
  //    При cloudTranslate сервер возвращает готовый перевод — возвращаем его
  //    сразу; иначе распознанный текст идёт в обычный MT-путь ниже.
  //    Любая ошибка (сеть, ключ, блокировка) молча уводит на локальный путь.
  let sourceText = '';
  let detectedBoxes: Box[] = [];
  if (regionOnly && settings.cloudOcr) {
    try {
      const cloud = await parseImageOcr(dataUrl, settings.sourceLang, settings.targetLang);
      // Строки сервера склеиваем как OCR-строки: переносы/дефисы — не границы фразы.
      sourceText = joinOcrLines(cloud.sourceText);
      if (settings.cloudTranslate && cloud.translatedText) {
        const cloudResult: TranslateResult = {
          source_text: cloud.sourceText,
          translation: cloud.translatedText,
          model: 'cloud:parseImage',
          detected_language: isMostlyCyrillic(cloud.sourceText) ? 'ru' : 'en',
          latency_ms: elapsed(),
        };
        await localCacheSet(scope, cacheId, cloudResult);
        return cloudResult;
      }
    } catch (e) {
      console.warn('[offscreen] cloud OCR failed, local fallback:', e);
    }
  }

  const hasTesseractPack = Boolean(vendor?.tesseract && vendor.baseUrl);
  // Native host может заменять вендор-пак tesseract-воркера.
  // Tesseract-пак не нужен, если текст уже пришёл из облака (без cloudTranslate).
  if (!sourceText && !hasTesseractPack && !settings.useNativeHost) {
    return fail('offline asset pack is missing: run npm run vendor and rebuild the extension');
  }
  if (!vendor?.pairs.length) {
    return fail('offline translation model pack is missing: run npm run vendor and rebuild the extension');
  }

  // 1.1) OCR (если текст не пришёл из облака) — либо встроенный tesseract-воркер, либо native host.
  const requestedLangs = settings.ocrLangs.length ? settings.ocrLangs : ['eng'];
  // Языковые пакеты, которых нет в офлайн-сборке, отбрасываем: иначе tesseract
  // упадёт на 404 вместо понятной ошибки.
  const bundledLangs = vendor?.ocrLangs ? new Set(vendor.ocrLangs) : null;
  const langs = bundledLangs ? requestedLangs.filter((l) => bundledLangs.has(l)) : requestedLangs;
  if (!sourceText) {
    if (!langs.length && !settings.useNativeHost) {
      return fail(i18n.t('local.errOcrLangMissing', { langs: requestedLangs.join(', ') }));
    }
    try {
      if (settings.useNativeHost) {
        const native = await sendNativeMessage({ action: 'ocr', image_base64: dataUrl, langs });
        if (!native.ok) {
          return fail(`Native OCR: ${native.error ?? 'host did not respond'}`);
        }
        sourceText = joinOcrLines(native.source_text ?? '');
        detectedBoxes = (native.boxes ?? []).map((b) => ({
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          // Многострочный бокс уходит в MT одной строкой (как на tesseract-пути).
          text: joinOcrLines(b.text ?? ''),
        }));
      } else {
        const ocrRes = await ocrFromDataUrl(dataUrl, langs, vendor, settings, regionOnly);
        sourceText = ocrRes.text;
        detectedBoxes = ocrRes.boxes;
      }
    } catch (e) {
      return fail(`OCR: ${String(e)}`);
    }
  }
  if (!sourceText) {
    return { source_text: '', translation: '', model: 'local', boxes: [], latency_ms: elapsed() };
  }

  const detected = isMostlyCyrillic(sourceText) ? 'ru' : 'en';

  // Внешний переводчик включён и приоритетнее локальной модели?
  const externalFirst = settings.externalMt !== 'off' && settings.externalMtPriority === 'prefer';
  const tryExternal = () =>
    externalTranslate(settings, sourceText, detected, scope, cacheId, elapsed, detectedBoxes);

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
      boxes: detectedBoxes.map((b) => ({ ...b, translation: b.text })),
      latency_ms: elapsed(),
    };
    await localCacheSet(scope, cacheId, passthrough);
    return passthrough;
  }

  // 2.1) Внешний переводчик первым: сеть вместо локальной ONNX-модели.
  // Модели при этом не загружаются — экономится память и время.
  let externalError: string | undefined;
  if (externalFirst) {
    const ext = await tryExternal();
    if (!ext.error) return ext;
    externalError = ext.error;
  }

  if (!pick.pair) {
    if (externalFirst && externalError) {
      // Внешний уже пробовали и он упал, локальной пары тоже нет — показываем причину.
      return fail(externalError, sourceText);
    }
    if (!externalFirst && settings.externalMt !== 'off') {
      return tryExternal();
    }
    return fail(i18n.t('local.errPairMissing', { pair: pick.missingPair ?? '?' }), sourceText);
  }

  // 3) NMT (модель загружается только из встроенного офлайн-пака ассетов).
  try {
    await mt.ensurePair(pick.pair, vendor);
  } catch (e) {
    if (!externalFirst && settings.externalMt !== 'off') {
      return tryExternal();
    }
    return fail(`${i18n.t('local.errModelLoad')}: ${String((e as Error).message ?? e)}`, sourceText);
  }

  try {
    const chunks = chunkText(sourceText);
    const parts: string[] = [];
    for (const chunk of chunks) {
      parts.push(await mt.translate(pick.pair, chunk));
    }
    const fullTranslation = parts.join('\n');

    // Переводим текст в боксах, чтобы пузыри речи отображали перевод
    const translatedBoxes: Box[] = [];
    for (const b of detectedBoxes) {
      const boxText = (b.text ?? '').trim();
      if (!boxText) continue;
      try {
        const trans = await mt.translate(pick.pair, boxText);
        translatedBoxes.push({
          ...b,
          translation: trans,
        });
      } catch {
        translatedBoxes.push({
          ...b,
          translation: fullTranslation, // фолбэк на общий перевод
        });
      }
    }

    const result: TranslateResult = {
      source_text: sourceText,
      translation: fullTranslation,
      model: `local:${pick.pair}`,
      detected_language: detected,
      boxes: translatedBoxes,
      latency_ms: elapsed(),
    };
    await localCacheSet(scope, cacheId, result);
    return result;
  } catch (e) {
    if (!externalFirst && settings.externalMt !== 'off') {
      return tryExternal();
    }
    return fail(`${i18n.t('local.errMtFailed')}: ${String((e as Error).message ?? e)}`, sourceText);
  }
}

/** Провайдер внешнего перевода из настроек (вызывается только при externalMt !== 'off'). */
function externalProvider(settings: LocalEngineSettings): MtProvider {
  return settings.externalMt === 'yandex' || settings.externalMt === 'yandex-cloud'
    ? (settings.externalMt as MtProvider)
    : 'google';
}

/** Опции внешнего MT из настроек: ключ Яндекс.Облака для провайдера yandex-cloud. */
function externalMtOptions(settings: LocalEngineSettings): { provider: MtProvider; yandexCloudApiKey?: string } {
  return {
    provider: externalProvider(settings),
    ...(externalProvider(settings) === 'yandex-cloud' && settings.yandexCloudApiKey
      ? { yandexCloudApiKey: settings.yandexCloudApiKey }
      : {}),
  };
}

/**
 * Внешний переводчик (Google или Яндекс): текст уходит на внешний сервис,
 * поэтому вызывается только когда провайдер явно выбран в настройках — первым
 * шагом ('prefer') или как запасной вариант при сбое локальной модели.
 * Никогда не бросает: сбои возвращаются как TranslateResult с `error`.
 */
async function externalTranslate(
  settings: LocalEngineSettings,
  sourceText: string,
  detected: string,
  scope: string,
  cacheId: string,
  elapsed: () => number,
  detectedBoxes: Box[] = [],
): Promise<TranslateResult> {
  const { from, to } = guessExternalDirection(settings, sourceText);
  const provider = externalProvider(settings);
  const source = settings.sourceLang === 'auto' ? 'auto' : from;
  try {
    const { translation, detected: extDetected } = await translateLongText(sourceText, source, to, {
      ...externalMtOptions(settings),
    });
    if (!translation.trim()) {
      return {
        source_text: sourceText,
        translation: '',
        model: `external:${provider}:${from}-${to}`,
        latency_ms: elapsed(),
        error: i18n.t('local.errExternalFailed'),
      };
    }
    // Каждый пузырь переводим отдельно (как на локальном пути), чтобы в пузырях
    // речи был свой текст; при сбое падаем на общий перевод.
    const boxes = await translateBoxesExternal(
      detectedBoxes,
      settings,
      source,
      to,
      translation.trim(),
    );
    const result: TranslateResult = {
      source_text: sourceText,
      translation,
      model: `external:${provider}:${from}-${to}`,
      detected_language: extDetected ?? detected,
      boxes,
      latency_ms: elapsed(),
    };
    await localCacheSet(scope, cacheId, result);
    return result;
  } catch (e) {
    return {
      source_text: sourceText,
      translation: '',
      model: `external:${provider}:${from}-${to}`,
      latency_ms: elapsed(),
      error: `${i18n.t('local.errExternalFailed')}: ${String((e as Error).message ?? e)}`,
    };
  }
}

/** Перевод текста каждого бокса через внешний сервис с фолбэком на общий перевод. */
async function translateBoxesExternal(
  boxes: Box[],
  settings: LocalEngineSettings,
  source: string,
  target: string,
  fullTranslation: string,
): Promise<Box[]> {
  const out: Box[] = [];
  const options = externalMtOptions(settings);
  for (const b of boxes) {
    const boxText = (b.text ?? '').trim();
    if (!boxText) continue;
    try {
      const { translation } = await translateLongText(boxText, source, target, options);
      out.push({ ...b, translation: translation.trim() || fullTranslation });
    } catch {
      out.push({ ...b, translation: fullTranslation });
    }
  }
  return out;
}

/** Направление для внешнего MT по той же эвристике письма, что и pickPair. */
function guessExternalDirection(
  settings: LocalEngineSettings,
  sourceText: string,
): { from: string; to: string } {
  const to = settings.targetLang;
  if (settings.sourceLang !== 'auto') return { from: settings.sourceLang, ...{ to } };
  return { from: isMostlyCyrillic(sourceText) ? 'ru' : 'en', to };
}
