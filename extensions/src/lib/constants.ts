import type { Settings } from './types';

export const STORAGE_KEY = 'translateExt.settings';

export const DEFAULT_SETTINGS: Settings = {
  // 'ai' — безсерверный режим по умолчанию: прямой вызов AI Vision API из браузера.
  engine: 'ai',
  geminiApiKey: '',
  geminiModel: 'gemini-3.8-flash',
  openaiApiKey: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o',
  customAiBaseUrl: '',
  customAiApiKey: '',
  customAiModel: '',
  pollinationsModel: 'openai',
  pollinationsApiKey: '',
  // OpenRouter: бесплатные vision-модели без карты; дефолт — роутер свободных моделей.
  openrouterApiKey: '',
  openrouterModel: 'openrouter/free',
  // Автономный режим по умолчанию полностью офлайновый; внешний MT — осознанный opt-in.
  // Когда внешний включён, он идёт первым, а локальная модель — запасной вариант.
  externalMt: 'off',
  externalMtPriority: 'prefer',
  yandexCloudApiKey: '',
  bubbleShape: 'oval',
  useNativeHost: false,
  ocrLangs: ['eng', 'rus'],
  ocrQuality: 'balanced',
  mtPair: 'en-ru',
  ocrMinConfidence: 40,
  translateConcurrency: 1,
  // Настройки движка backend (необязательного):
  backendUrl: 'http://127.0.0.1:8000',
  targetLang: 'ru',
  sourceLang: 'auto',
  model: 'gemini',
  uiLang: 'auto',
  minImageSize: 96,
  autoScan: false,
  // Облачный OCR выделенной области (uLanguage/backenster) выключен по
  // умолчанию: изображение уходит на сторонний сервер только по согласию.
  cloudOcr: false,
  cloudTranslate: false,
};

/** Языки, предлагаемые в интерфейсе. Добавляйте при необходимости. */
export const LANGUAGES = [
  { code: 'ru', label: 'Русский' },
  { code: 'en', label: 'English' },
  { code: 'uk', label: 'Українська' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'zh', label: '中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
];

export const MODELS: { id: Settings['model']; label: string; hint: string }[] = [
  { id: 'gemini', label: 'Gemini Vision', hint: 'Google Gemini — fast, cheap, direct API key' },
  { id: 'openai', label: 'OpenAI Vision', hint: 'GPT-4o — best quality, direct API key' },
  { id: 'local', label: 'Local (offline)', hint: 'tesseract.js + Transformers.js, no API key' },
  { id: 'tesseract', label: 'Tesseract (OCR)', hint: 'Same as Local — explicit' },
  { id: 'custom', label: 'Custom API', hint: 'Your own model endpoint' },
  { id: 'pollinations', label: 'Pollinations (free)', hint: 'Free OpenAI-compatible Vision — key from enter.pollinations.ai' },
  { id: 'openrouter', label: 'OpenRouter (free)', hint: 'Free vision models via one key, no card — openrouter.ai' },
];

/** Vision-модели, доступные напрямую из браузера (без бэкенда). */
export const DIRECT_AI_MODELS: Settings['model'][] = ['gemini', 'openai', 'custom', 'pollinations', 'openrouter'];
