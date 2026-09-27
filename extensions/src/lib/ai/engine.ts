import type { Settings, TranslateResult } from '../types';
import { translateWithGemini } from './geminiClient';
import { translateWithOpenAI } from './openaiClient';

/**
 * Безсерверный диспетчер AI Vision: выполняется целиком в браузере против
 * вендорского эндпоинта. Ключи хранятся в storage расширения и никогда не
 * проксируются через сторонний сервер.
 *
 * Никогда не бросает исключение: сбои возвращаются как TranslateResult с `error`.
 */
export async function translateWithAI(
  dataUrl: string,
  settings: Settings,
): Promise<TranslateResult> {
  const { model, targetLang, sourceLang } = settings;

  if (model === 'custom') {
    return translateWithOpenAI(dataUrl, {
      apiKey: settings.customAiApiKey,
      baseUrl: settings.customAiBaseUrl || 'http://localhost:11434/v1',
      model: settings.customAiModel || 'default',
      targetLang,
      sourceLang,
    });
  }

  if (model === 'pollinations') {
    // Pollinations: новый gen-эндпоинт (старый text.pollinations.ai — legacy и
    // больше не принимает изображения). Модель по умолчанию `openai` — это
    // alias `openai/gpt-5.4-nano` с поддержкой изображений.
    // Ключ обязателен для vision; бесплатный — enter.pollinations.ai/keys.
    return translateWithOpenAI(dataUrl, {
      url: 'https://gen.pollinations.ai/v1/chat/completions',
      apiKey: settings.pollinationsApiKey.trim(),
      model: settings.pollinationsModel || 'openai',
      providerLabel: 'pollinations',
      allowAnonymous: true,
      targetLang,
      sourceLang,
      timeoutMs: 90_000,
    });
  }

  if (model === 'openai') {
    return translateWithOpenAI(dataUrl, {
      apiKey: settings.openaiApiKey,
      baseUrl: settings.openaiBaseUrl,
      model: settings.openaiModel,
      targetLang,
      sourceLang,
    });
  }

  if (model === 'openrouter') {
    // OpenRouter: один ключ на все бесплатные модели, карты не просит.
    // `openrouter/free` — роутер: сам подбирает свободную vision-модель.
    // Бесплатные id ротируются, поэтому дефолт — роутер, а не конкретная модель.
    return translateWithOpenAI(dataUrl, {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: settings.openrouterApiKey.trim(),
      model: settings.openrouterModel.trim() || 'openrouter/free',
      providerLabel: 'openrouter',
      targetLang,
      sourceLang,
      timeoutMs: 90_000,
      extraHeaders: {
        'HTTP-Referer': 'https://github.com/translate-ext',
        'X-Title': 'translate-ext',
      },
    });
  }

  // Gemini — по умолчанию (и id модели по умолчанию).
  return translateWithGemini(dataUrl, {
    apiKey: settings.geminiApiKey,
    model: settings.geminiModel || 'gemini-3.8-flash',
    targetLang,
    sourceLang,
  });
}

/** true, если для выбранной AI-модели задан рабочий API-ключ. */
export function hasDirectAiKey(settings: Settings): boolean {
  // Pollinations принимает изображения только с ключом (анонимно — лишь текст).
  if (settings.model === 'pollinations') return Boolean(settings.pollinationsApiKey.trim());
  if (settings.model === 'openrouter') return Boolean(settings.openrouterApiKey.trim());
  if (settings.model === 'custom') return Boolean(settings.customAiBaseUrl.trim());
  if (settings.model === 'openai') return Boolean(settings.openaiApiKey.trim());
  return Boolean(settings.geminiApiKey.trim());
}
