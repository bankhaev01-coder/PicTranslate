import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { translateImage } from '@/lib/api';
import { hasDirectAiKey, translateWithAI } from '@/lib/ai/engine';
import { checkNativeHost } from '@/lib/native/nativeClient';
import { getSettings } from '@/lib/storage';
import type { CaptureVisibleResponse, Msg, ScanImagesResponse, TranslateResult } from '@/lib/types';

export default defineBackground(() => {
  /* ── контекстное меню ── */
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
      id: 'translate-images',
      title: 'Translate images on this page',
      contexts: ['page', 'image'],
    });
  });

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'translate-images' && tab?.id != null) {
      try {
        await ensureContentScript(tab.id);
        await browser.tabs.sendMessage(tab.id, { type: 'SCAN_IMAGES' } satisfies Msg);
      } catch {
        /* контент-скрипт на этой странице не внедряется (chrome://, store, ...) */
      }
    }
  });

  /* ── роутер сообщений ── */
  browser.runtime.onMessage.addListener((msg: Msg, sender, sendResponse) => {
    // Сообщения, адресованные offscreen-документу, обрабатываются только там.
    if ((msg as { target?: string }).target === 'offscreen') return false;
    handle(msg, sender)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e) }));
    return true; // держим канал открытым для асинхронного ответа
  });
});

async function handle(
  msg: Msg,
  sender: { tab?: { windowId?: number } },
): Promise<unknown> {
  switch (msg.type) {
    case 'PING':
      return { ok: true };

    case 'OPEN_OPTIONS':
      browser.runtime.openOptionsPage();
      return { ok: true };

    case 'SCAN_TAB': {
      await ensureContentScript(msg.tabId);
      return (await browser.tabs.sendMessage(msg.tabId, {
        type: 'SCAN_IMAGES',
      } satisfies Msg)) as ScanImagesResponse;
    }

    case 'TRANSLATE_DATA_URL': {
      const settings = await getSettings();
      return translateByEngine(msg.dataUrl, settings, msg.regionOnly ?? false);
    }

    case 'CAPTURE_VISIBLE':
      return captureVisible(sender.tab?.windowId);

    case 'CAPTURE_AND_TRANSLATE': {
      const cap = await captureVisible(sender.tab?.windowId);
      if (!cap.dataUrl) {
        return {
          source_text: '',
          translation: '',
          model: 'n/a',
          latency_ms: 0,
          error: cap.error ?? 'capture failed',
        } satisfies TranslateResult;
      }
      const settings = await getSettings();
      return translateByEngine(cap.dataUrl, settings, false);
    }

    case 'CHECK_NATIVE_HOST':
      return checkNativeHost();

    default:
      return { error: `unknown message: ${(msg as { type?: string })?.type}` };
  }
}

/**
 * Провести изображение через движок, выбранный в настройках.
 *   'ai'      → прямой vendor Vision API (безсерверный, по умолчанию)
 *   'local'   → offscreen OCR + NMT конвейер
 *   'backend' → self-hosted FastAPI-бэкенд
 */
async function translateByEngine(
  dataUrl: string,
  settings: Awaited<ReturnType<typeof getSettings>>,
  regionOnly: boolean,
): Promise<TranslateResult> {
  if (settings.engine === 'ai') {
    if (!hasDirectAiKey(settings)) {
      return {
        source_text: '',
        translation: '',
        model: `ai:${settings.model}`,
        latency_ms: 0,
        error: i18nMissingKey(settings.model),
      } satisfies TranslateResult;
    }
    return translateWithAI(dataUrl, settings);
  }

  if (settings.engine === 'backend') {
    return translateDataUrl(dataUrl, regionOnly);
  }

  // Локальный движок: переслать в offscreen-документ (владеет OCR+NMT воркерами).
  await ensureOffscreen();
  return browser.runtime.sendMessage({
    type: 'TRANSLATE_LOCAL',
    target: 'offscreen',
    dataUrl,
    regionOnly,
  } satisfies Msg);
}

/** Читаемая ошибка об отсутствии API-ключа; дублируется в локалях. */
function i18nMissingKey(model: string): string {
  const vendor = model === 'openai' ? 'OpenAI' : 'Gemini';
  return `${vendor} API key is not configured — open Settings and add your key.`;
}

async function translateDataUrl(dataUrl: string, regionOnly: boolean): Promise<TranslateResult> {
  const s = await getSettings();
  const blob = await (await fetch(dataUrl)).blob();
  return translateImage({
    backendUrl: s.backendUrl,
    blob,
    targetLang: s.targetLang,
    sourceLang: s.sourceLang,
    model: s.model,
    regionOnly,
  });
}

async function captureVisible(windowId?: number): Promise<CaptureVisibleResponse> {
  try {
    const dataUrl = await browser.tabs.captureVisibleTab(windowId ?? browser.windows.WINDOW_ID_CURRENT, {
      format: 'png',
    });
    return { dataUrl };
  } catch (e) {
    return { error: `captureVisibleTab failed: ${String(e)}` };
  }
}

/**
 * Внедрить runtime-контент-скрипт во вкладку, если он ещё не внедрён.
 * Использует activeTab + scripting (в манифесте нет <all_urls>).
 */
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, { type: 'PING' } satisfies Msg);
    return; // уже внедрён
  } catch {
    /* ещё не внедрён — идём дальше */
  }
  await browser.scripting.executeScript({
    target: { tabId },
    files: ['injected.js'],
  });
}

/**
 * Открыть offscreen-документ (reason WORKERS) для локального движка.
 * В нём живут tesseract-воркер и ONNX NMT-воркер.
 */
async function ensureOffscreen(): Promise<void> {
  const api = (browser as unknown as {
    offscreen?: {
      hasDocument?: () => Promise<boolean>;
      createDocument: (p: { url: string; reasons: string[]; justification: string }) => Promise<void>;
    };
  }).offscreen;
  if (!api) return;
  try {
    if (api.hasDocument) {
      if (await api.hasDocument()) return;
    }
    await api.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Run local OCR (tesseract.js) and offline translation (ONNX) web workers',
    });
  } catch {
    // Документ offscreen может быть только один — конкурентный create не страшен.
  }
}
