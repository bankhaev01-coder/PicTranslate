import type { Settings } from '../types';

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
export const GROQ_VISION_MODEL = 'qwen/qwen3.8-27b';

/** Explicit settings-only opt-in. Never copy another provider's secret to Groq.
 * No network call, permission grant, fallback or paid model selection here.
 */
export function groqVisionPreset(settings: Settings): Partial<Settings> {
  const sameProvider = settings.customAiBaseUrl.trim().replace(/\/+$/, '') === GROQ_BASE_URL;
  return { model: 'custom', customAiBaseUrl: GROQ_BASE_URL, customAiModel: GROQ_VISION_MODEL,
    customAiApiKey: sameProvider ? settings.customAiApiKey : '' };
}
