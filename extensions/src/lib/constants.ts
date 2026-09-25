import type { Settings } from './types';

export const STORAGE_KEY = 'translateExt.settings';

export const DEFAULT_SETTINGS: Settings = {
  // 'ai' — безсерверный режим по умолчанию: прямой вызов AI Vision API из браузера.
  engine: 'ai',
  geminiApiKey: '',
  geminiModel: 'gemini-1.5-flash',
  openaiApiKey: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o',
  useNativeHost: false,
  ocrLangs: ['eng', 'rus'],
  mtPair: 'en-ru',
  // Настройки движка backend (необязательного):
  backendUrl: 'http://127.0.0.1:8000',
  targetLang: 'ru',
  sourceLang: 'auto',
  model: 'gemini',
  uiLang: 'auto',
  minImageSize: 96,
  autoScan: false,
};

/** Число параллельных запросов перевода в background-воркер. */
export const TRANSLATE_CONCURRENCY = 3;

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
];

/** Vision-модели, доступные напрямую из браузера (без бэкенда). */
export const DIRECT_AI_MODELS: Settings['model'][] = ['gemini', 'openai'];
