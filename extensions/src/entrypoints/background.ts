import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { translateImage } from '@/lib/api';
import { hasDirectAiKey, translateWithAI } from '@/lib/ai/engine';
import { checkNativeHost, sendNativeMessage } from '@/lib/native/nativeClient';
import { getSettings } from '@/lib/storage';
import type {
  CaptureVisibleResponse,
  ContentMsg,
  Msg,
  ScanImagesResponse,
  TranslateResult,
} from '@/lib/types';

export default defineBackground(() => {
  /* ── контекстное меню ── */
  browser.runtime.onInstalled.addListener(() => {
    // onInstalled срабатывает и при обновлении/перезагрузке расширения: старый пункт
    // с тем же id дал бы ошибку «duplicate id». Поэтому сначала убираем все пункты.
    void setupContextMenu();
  });

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === MENU_TRANSLATE_IMAGES && tab?.id != null) {
      try {
        await ensureContentScript(tab.id);
        await browser.tabs.sendMessage(tab.id, { type: 'SCAN_IMAGES' } satisfies ContentMsg);
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

const MENU_TRANSLATE_IMAGES = 'translate-images';

async function setupContextMenu(): Promise<void> {
  try {
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({
      id: MENU_TRANSLATE_IMAGES,
      title: 'Translate images on this page',
      contexts: ['page', 'image'],
    });
  } catch (e) {
    console.warn('[translate-ext] context menu setup failed:', e);
  }
}

type Sender = {
  id?: string;
  url?: string;
  tab?: { id?: number; windowId?: number };
};

/**
 * NATIVE_HOST_CALL даёт доступ к локальному процессу, поэтому принимаем его только
 * от страниц самого расширения (offscreen и т.п.), но не от контент-скриптов
 * на чужих страницах и не от других расширений.
 */
function isOwnExtensionPage(sender: Sender): boolean {
  if (sender.id !== browser.runtime.id) return false;
  if (sender.tab) return false; // контент-скрипт во вкладке
  // Типы WXT допускают только известные пути бандла; нам нужен корень расширения.
  const origin = (browser.runtime as unknown as { getURL: (path: string) => string }).getURL('/');
  return typeof sender.url === 'string' && sender.url.startsWith(origin);
}

async function handle(msg: Msg, sender: Sender): Promise<unknown> {
  switch (msg.type) {
    case 'PING':
      return { ok: true };

    case 'OPEN_OPTIONS':
      try {
        await browser.runtime.openOptionsPage();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `openOptionsPage failed: ${String(e)}` };
      }

    case 'SCAN_TAB': {
      await ensureContentScript(msg.tabId);
      return (await browser.tabs.sendMessage(msg.tabId, {
        type: 'SCAN_IMAGES',
      } satisfies ContentMsg)) as ScanImagesResponse;
    }

    case 'CLEAR_OVERLAY': {
      // Роутер для CLEAR_OVERLAY обязателен: скрипт страницы умеет убить панель,
      // но без этого кейса сообщение из popup до него не доходит.
      await ensureContentScript(msg.tabId);
      return (await browser.tabs.sendMessage(msg.tabId, {
        type: 'CLEAR_OVERLAY',
      } satisfies ContentMsg)) as { ok: boolean };
    }

    case 'TRANSLATE_DATA_URL': {
      const settings = await getSettings();
      return translateByEngine(msg.dataUrl, settings, msg.regionOnly ?? false);
    }

    case 'CAPTURE_VISIBLE': {
      if (sender.tab?.id != null) {
        const active = await browser.tabs.query({ active: true, windowId: sender.tab.windowId });
        if (active[0]?.id !== sender.tab.id) return { error: 'Tab is no longer active; capture cancelled' };
      }
      return captureVisible(sender.tab?.windowId);
    }

    case 'CAPTURE_AND_TRANSLATE': {
      if (msg.tabId == null) return { source_text: '', translation: '', model: 'n/a', latency_ms: 0,
        error: 'No active tab for screenshot translation' } satisfies TranslateResult;
      await ensureContentScript(msg.tabId);
      return browser.tabs.sendMessage(msg.tabId, { type: 'TRANSLATE_VIEWPORT' } satisfies ContentMsg);
    }

    case 'CHECK_NATIVE_HOST':
      return checkNativeHost();

    case 'NATIVE_HOST_CALL':
      // Маршрут для offscreen: там недоступен chrome.runtime.sendNativeMessage.
      if (!isOwnExtensionPage(sender)) {
        return { ok: false, error: 'NATIVE_HOST_CALL is only allowed from extension pages' };
      }
      return sendNativeMessage(msg.request);

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
    return translateDataUrl(dataUrl, settings, regionOnly);
  }

  // Локальный движок: переслать в offscreen-документ (владеет OCR+NMT воркерами).
  // Настройки передаём сообщением: в offscreen недоступен chrome.storage.
  try {
    await ensureOffscreen();
  } catch (e) {
    return {
      source_text: '',
      translation: '',
      model: 'local',
      latency_ms: 0,
      error: e instanceof Error ? e.message : String(e),
    } satisfies TranslateResult;
  }
  return browser.runtime.sendMessage({
    type: 'TRANSLATE_LOCAL',
    target: 'offscreen',
    dataUrl,
    regionOnly,
    settings: {
      uiLang: settings.uiLang,
      targetLang: settings.targetLang,
      sourceLang: settings.sourceLang,
      ocrLangs: settings.ocrLangs,
      ocrQuality: settings.ocrQuality,
      japaneseOcrLayout: settings.japaneseOcrLayout,
      mtPair: settings.mtPair,
      useNativeHost: settings.useNativeHost,
      externalMt: settings.externalMt,
      externalMtPriority: settings.externalMtPriority,
      yandexCloudApiKey: settings.yandexCloudApiKey ?? '',
      ocrMinConfidence: settings.ocrMinConfidence ?? 40,
      cloudOcr: settings.cloudOcr,
      cloudTranslate: settings.cloudTranslate,
    },
  } satisfies Msg);
}

/** Читаемая ошибка об отсутствии API-ключа; дублируется в локалях. */
function i18nMissingKey(model: string): string {
  if (model === 'pollinations') {
    return 'Pollinations requires a free API key — get one at https://enter.pollinations.ai/keys and paste it in Settings.';
  }
  const vendor = model === 'openai' ? 'OpenAI' : 'Gemini';
  return `${vendor} API key is not configured — open Settings and add your key.`;
}

async function translateDataUrl(
  dataUrl: string,
  s: Awaited<ReturnType<typeof getSettings>>,
  regionOnly: boolean,
): Promise<TranslateResult> {
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
 * Открыть offscreen-документ (reason WORKERS) для локального движка и дождаться готовности.
 * В нём живут tesseract-воркер и ONNX NMT-воркер.
 * Бросает понятную ошибку, если документ не создан или не ответил на PING
 * (раньше функция молча завершалась, и дальше падало «Receiving end does not exist»).
 */
async function ensureOffscreen(): Promise<void> {
  const api = (browser as unknown as {
    offscreen?: {
      hasDocument?: () => Promise<boolean>;
      createDocument: (p: { url: string; reasons: string[]; justification: string }) => Promise<void>;
    };
  }).offscreen;
  if (!api) throw new Error('Local engine is unavailable: offscreen API is not supported by this browser');

  const isCreated = api.hasDocument ? await api.hasDocument().catch(() => false) : false;
  if (!isCreated) {
    try {
      await api.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run local OCR (tesseract.js) and offline translation (ONNX) web workers',
      });
    } catch (e) {
      // Документ offscreen может быть только один: если его уже создал конкурентный
      // вызов — нормально. Иначе это настоящая ошибка создания.
      const existsNow = api.hasDocument ? await api.hasDocument().catch(() => false) : false;
      if (!existsNow && !/single offscreen|only a single/i.test(String(e))) {
        throw new Error(`Failed to create offscreen document: ${String(e)}`);
      }
    }
  }

  // Handshake / ping с retry для устранения гонки "Receiving end does not exist"
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const resp = (await browser.runtime.sendMessage({
        type: 'PING',
        target: 'offscreen',
      } satisfies Msg)) as { ok?: boolean } | undefined;
      if (resp?.ok) return;
    } catch {
      // Offscreen еще не успел инициализироваться или повесить слушатель
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Local engine is unavailable: offscreen document did not respond');
}
