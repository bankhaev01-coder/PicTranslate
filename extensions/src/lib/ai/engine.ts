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

  if (model === 'openai') {
    return translateWithOpenAI(dataUrl, {
      apiKey: settings.openaiApiKey,
      baseUrl: settings.openaiBaseUrl,
      model: settings.openaiModel,
      targetLang,
      sourceLang,
    });
  }

  // Gemini — по умолчанию (и id модели по умолчанию).
  return translateWithGemini(dataUrl, {
    apiKey: settings.geminiApiKey,
    model: settings.geminiModel || 'gemini-1.5-flash',
    targetLang,
    sourceLang,
  });
}

/** true, если для выбранной AI-модели задан рабочий API-ключ. */
export function hasDirectAiKey(settings: Settings): boolean {
  if (settings.model === 'openai') return Boolean(settings.openaiApiKey.trim());
  return Boolean(settings.geminiApiKey.trim());
}
