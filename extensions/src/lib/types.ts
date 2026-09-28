/** Общие типы расширения (зеркалят Pydantic-схемы бэкенда). */
import type { NativeHostRequest } from './native/nativeClient';

/** Идентификаторы моделей, понимаемые бэкендом. */
export type ModelId = 'local' | 'tesseract' | 'openai' | 'gemini' | 'custom' | 'pollinations' | 'openrouter';

/** Форма комикс-облачка с переводом поверх найденных текстовых блоков. */
export type BubbleShape = 'rectangle' | 'oval' | 'none';

/** Внешний переводчик для автономного движка (распознанный ТЕКСТ уходит в сеть). */
export type ExternalMtProvider = 'off' | 'google' | 'yandex';

/**
 * Порядок применения внешнего переводчика:
 *  - 'prefer'   → сначала внешний сервис, локальная NMT-модель только при сбое;
 *  - 'fallback' → сначала локальная модель, внешний сервис только при сбое.
 */
export type ExternalMtPriority = 'prefer' | 'fallback';

/** Насколько усердно локальный OCR улучшает картинку перед распознаванием. */
export type OcrQuality = 'fast' | 'balanced' | 'best';

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
  /** Кастомный AI Vision провайдер (прямой вызов из браузера, OpenAI-совместимый) */
  customAiBaseUrl: string;
  customAiApiKey: string;
  customAiModel: string;
  /** Бесплатный провайдер Pollinations (OpenAI-совместимый) */
  pollinationsModel: string;
  /**
   * API-ключ Pollinations. Для распознавания изображений он обязателен:
   * без ключа анонимный tier принимает только текст (см. docs/decisions/01-arch.md).
   */
  pollinationsApiKey: string;
  /**
   * OpenRouter: единый ключ на бесплатные vision-модели (OpenAI-совместимый
   * эндпоинт, без карты). По умолчанию роутер `openrouter/free` сам подбирает
   * свободную модель с поддержкой картинок; можно вписать конкретный id.
   */
  openrouterApiKey: string;
  openrouterModel: string;
  /**
   * Автономный режим: внешний переводчик (Google/Яндекс) для распознанного ТЕКСТА.
   * 'off' по умолчанию — автономный режим остаётся офлайновым.
   */
  externalMt: ExternalMtProvider;
  /** 'prefer' — внешний переводчик пробуется первым, локальная модель как запасной вариант. */
  externalMtPriority: ExternalMtPriority;
  /** Форма облачка с речевым переводом над комиксами */
  bubbleShape: BubbleShape;
  /** Использовать Chrome Native Messaging хост для Tesseract */
  useNativeHost: boolean;
  /** Языковые пакеты OCR для локального движка (tesseract.js). */
  ocrLangs: string[];
  /**
   * Сколько вариантов предобработки пробовать при OCR: 'fast' — один проход,
   * 'balanced' — два (по умолчанию), 'best' — четыре с ранним выходом.
   */
  ocrQuality: OcrQuality;
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
  /** Порог уверенности OCR (0-100) для включения текстового блока/слова */
  ocrMinConfidence: number;
  /** Количество одновременных задач перевода (1-5, по умолчанию 1) */
  translateConcurrency: number;
  /** Пропускать изображения меньше этого размера (px) — чтобы не переводить иконки/аватары */
  minImageSize: number;
  /** Автозапуск сканирования при загрузке страницы */
  autoScan: boolean;
  /**
   * Облачное OCR выделенной области через backenster parseImage (способ
   * uLanguage): кроп уходит на сторонний сервер; при ошибке — локальный
   * Tesseract. Сканирование всей страницы всегда локальное (нужны bbox).
   */
  cloudOcr: boolean;
  /** Переводить тем же серверным запросом (иначе текст идёт в свой MT-движок). */
  cloudTranslate: boolean;
}

/**
 * Срез настроек для автономного движка: в offscreen-документе недоступны
 * chrome.storage (Chromium: контекст offscreen_extension), поэтому настройки
 * передаются сообщением от background.
 */
export type LocalEngineSettings = Pick<
  Settings,
  | 'uiLang'
  | 'targetLang'
  | 'sourceLang'
  | 'ocrLangs'
  | 'ocrQuality'
  | 'mtPair'
  | 'useNativeHost'
  | 'externalMt'
  | 'externalMtPriority'
  | 'ocrMinConfidence'
  | 'cloudOcr'
  | 'cloudTranslate'
>;

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
  id?: string;
  shape: SelectionShape;
  /**
   * Рамка области в координатах ДОКУМЕНТА (client + scroll на момент рисования).
   * Скролл после выделения кроп и плашки не сбивает: вьюпорт пересчитывается
   * из документа в момент скриншота (см. regionToViewport / cropRegion).
   */
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Точки лассо тоже в координатах документа. */
  points?: Point[]; // обязателен для лассо
  /**
   * Поколение выделения: ставится при создании области. Esc/«Очистить»/новый
   * скан во время перевода — прилетевшие позже плашки дропаются по токену.
   */
  token?: number;
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
  | { type: 'PING'; target?: 'offscreen' }
  /** popup → background: убрать панель перевода с указанной вкладки */
  | { type: 'CLEAR_OVERLAY'; tabId: number }
  /** → background: открыть страницу настроек */
  | { type: 'OPEN_OPTIONS' }
  /** popup → background: внедрить контент-скрипт (если нужно) и просканировать вкладку */
  | { type: 'SCAN_TAB'; tabId: number }
  /* ── локальный движок (offscreen-документ) ─────────────────── */
  /** background → offscreen (target:'offscreen'): запустить локальный конвейер */
  | { type: 'TRANSLATE_LOCAL'; target: 'offscreen'; dataUrl: string; regionOnly: boolean; settings: LocalEngineSettings }
  /** options → offscreen: очистить кеш результатов локального перевода */
  | { type: 'LOCAL_CACHE_CLEAR'; target: 'offscreen' }
  /** content → background: перевести изображение (data URL). Ответ: TranslateResult */
  | { type: 'TRANSLATE_DATA_URL'; imageId: string; dataUrl: string; regionOnly?: boolean }
  /** → background: скриншот видимой области вкладки. Ответ: { dataUrl } */
  | { type: 'CAPTURE_VISIBLE' }
  /** popup → background: скриншот + перевод видимой области. Ответ: TranslateResult */
  | { type: 'CAPTURE_AND_TRANSLATE' }
  /** options → background: проверка native messaging хоста. Ответ: { ok, info?, error? } */
  | { type: 'CHECK_NATIVE_HOST' }
  /** offscreen → background: нативный вызов (в offscreen нет runtime.sendNativeMessage) */
  | { type: 'NATIVE_HOST_CALL'; request: NativeHostRequest };

export interface CaptureVisibleResponse {
  dataUrl?: string;
  error?: string;
}

/**
 * Команды background → скрипт страницы: вкладка-адресат уже известна,
 * поэтому tabId в них не передаётся (в отличие от Msg для popup → background).
 */
export type ContentMsg = { type: 'SCAN_IMAGES' } | { type: 'CLEAR_OVERLAY' };

/** Ответ контент-скрипта на SCAN_IMAGES. */
export interface ScanImagesResponse {
  ok?: boolean;
  count?: number;
  error?: string;
}

