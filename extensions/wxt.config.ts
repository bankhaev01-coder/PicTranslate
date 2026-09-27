import { defineConfig } from 'wxt';

/**
 * Конфиг WXT — генерирует manifest.json (MV3) на этапе сборки.
 * Разрешения минимальны: activeTab + scripting — для внедряемого по запросу
 * скрипта, tabs — для captureVisibleTab, storage/offscreen — для настроек
 * и локальных воркеров.
 */
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  outDir: 'dist',
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    // offscreen → локальные OCR+NMT воркеры (автономный движок)
    permissions: ['activeTab', 'storage', 'scripting', 'tabs', 'contextMenus', 'offscreen', 'nativeMessaging'],
    // CPU ORT + WASM; в бандле удалённые ресурсы не нужны.
    // ВАЖНО для MV3: Chrome запрещает 'blob:' в script-src extension_pages —
    // иначе манифест не грузится ("Insecure CSP value"). Воркеры создаются
    // из файлов расширения (workerBlobURL = false), поэтому blob: не нужен.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    host_permissions: [
      // Прямые AI Vision API
      'https://generativelanguage.googleapis.com/*',
      'https://api.openai.com/*',
      // Бесплатный AI-провайдер Pollinations (OpenAI-совместимый gen-эндпоинт)
      'https://gen.pollinations.ai/*',
      // OpenRouter: бесплатные vision-модели через один ключ (OpenAI-совместимый)
      'https://openrouter.ai/*',
      // Внешние переводчики автономного движка (только при включённом externalMt)
      'https://translate.googleapis.com/*',
      'https://translate.yandex.net/*',
      // Локальный/self-hosted backend (офлайн-режим).
      'http://localhost/*',
      'http://127.0.0.1/*',
    ],
    // Произвольные эндпоинты для кастомных AI провайдеров
    optional_host_permissions: [
      'https://*/*',
      'http://*/*',
    ],
    icons: {
      16: '/icon/16.png',
      32: '/icon/32.png',
      48: '/icon/48.png',
      96: '/icon/96.png',
      128: '/icon/128.png',
    },
    action: {
      default_title: '__MSG_actionTitle__',
      default_icon: {
        16: '/icon/16.png',
        32: '/icon/32.png',
        48: '/icon/48.png',
      },
    },
    web_accessible_resources: [
      {
        resources: ['icon/*.png'],
        matches: ['<all_urls>'],
      },
    ],
  },
  vite: () => ({
    worker: { format: 'es' }, // модульные воркеры: mt.worker.ts / tesseract
  }),
});

