/** Общие типы расширения (зеркалят Pydantic-схемы бэкенда). */

/** Идентификаторы моделей, понимаемые бэкендом. */
export type ModelId = 'local' | 'tesseract' | 'openai' | 'gemini' | 'custom';

export interface Settings {
  /**
   * Какой движок выполняет OCR + перевод.
   *  - 'ai'      → прямой вызов AI Vision API в браузере (Gemini/OpenAI), безсерверный режим по умолчанию
   *  - 'local'   → офлайн OCR (tesseract.js или native host) + NMT (Transformers.js)
   *  - 'backend' → self-hosted FastAPI-бэкенд (режим для продвинутых)
   */
  engine: 'ai' | 'local' | 'backend';
  /** Прямые ключи AI Vision API (работа прямо в браузере, без бэкенда) */
  geminiApiKey: string;
  geminiModel: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  /** Использовать Chrome Native Messaging хост для Tesseract */
  useNativeHost: boolean;
  /** Языковые пакеты OCR для локального движка (tesseract.js). */
  ocrLangs: string[];
  /** Предпочтительная пара перевода, если исходный язык — 'auto'. */
  mtPair: string;
  /** Базовый URL бэкенда, например http://127.0.0.1:8000 (только engine: 'backend') */
  backendUrl: string;
  /** Целевой язык (BCP-47), например 'ru' */
  targetLang: string;
  /** Исходный язык или 'auto' */
  sourceLang: string;
  /** Какую модель использовать */
  model: ModelId;
  /** Язык интерфейса */
  uiLang: 'auto' | 'ru' | 'en';
  /** Пропускать изображения меньше этого размера (px) — чтобы не переводить иконки/аватары */
  minImageSize: number;
  /** Автозапуск сканирования при загрузке страницы */
  autoScan: boolean;
}

export interface PageImage {
  id: string;
  src: string;
  width: number;
  height: number;
  visible: boolean;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  translation?: string;
}

/**
 * Схема JSON, которую обязаны вернуть Vision-модели (Gemini/OpenAI).
 * Общий контракт для extractJson: поля необязательные, но при наличии —
 * правильных типов; битые ответы отбрасываются до {} на уровне extractJson.
 */
export interface AiJsonResponse {
  source_text?: string;
  translation?: string;
  detected_language?: string | null;
  boxes?: Box[];
}

export interface Point {
  x: number;
  y: number;
}

export type SelectionShape = 'rectangle' | 'oval' | 'lasso';

export interface SelectionRegion {
  shape: SelectionShape;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  points?: Point[]; // обязателен для лассо
}

export interface TranslateResult {
  source_text: string;
  translation: string;
  model: string;
  detected_language?: string | null;
  boxes?: Box[];
  latency_ms: number;
  /** заполняется расширением, если бэкенд недоступен */
  error?: string;
}

export type ImageStatus = 'idle' | 'queued' | 'working' | 'done' | 'error';

export interface ImageTask {
  imageId: string;
  status: ImageStatus;
  result?: TranslateResult;
}

/* ── Обмен сообщениями ──────────────────────────────────────── */

/**
 * Сообщения в формате request/response (sendMessage + sendResponse) — проще
 * широковещательной шины и достаточно для MVP:
 *   popup/content → background: TRANSLATE_DATA_URL, CAPTURE_VISIBLE, ...
 *   popup/background → content: SCAN_IMAGES, CLEAR_OVERLAY
 */
export type Msg =
  | { type: 'PING' }
  /** popup → content: просканировать страницу и показать панель оверлея */
  | { type: 'SCAN_IMAGES' }
  /** → content: убрать оверлей */
  | { type: 'CLEAR_OVERLAY' }
  /** → background: открыть страницу настроек */
  | { type: 'OPEN_OPTIONS' }
  /** popup → background: внедрить контент-скрипт (если нужно) и просканировать вкладку */
  | { type: 'SCAN_TAB'; tabId: number }
  /* ── локальный движок (offscreen-документ) ─────────────────── */
  /** background → offscreen (target:'offscreen'): запустить локальный конвейер */
  | { type: 'TRANSLATE_LOCAL'; target: 'offscreen'; dataUrl: string; regionOnly: boolean }
  /** options → offscreen: очистить кеш результатов локального перевода */
  | { type: 'LOCAL_CACHE_CLEAR'; target: 'offscreen' }
  /** content → background: перевести изображение (data URL). Ответ: TranslateResult */
  | { type: 'TRANSLATE_DATA_URL'; imageId: string; dataUrl: string; regionOnly?: boolean }
  /** → background: скриншот видимой области вкладки. Ответ: { dataUrl } */
  | { type: 'CAPTURE_VISIBLE' }
  /** popup → background: скриншот + перевод видимой области. Ответ: TranslateResult */
  | { type: 'CAPTURE_AND_TRANSLATE' }
  /** options → background: проверка native messaging хоста. Ответ: { ok, info?, error? } */
  | { type: 'CHECK_NATIVE_HOST' };

export interface CaptureVisibleResponse {
  dataUrl?: string;
  error?: string;
}

/** Ответ контент-скрипта на SCAN_IMAGES. */
export interface ScanImagesResponse {
  ok?: boolean;
  count?: number;
  error?: string;
}

