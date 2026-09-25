import type { TranslateResult } from './types';

export interface TranslateParams {
  backendUrl: string;
  blob: Blob;
  fileName?: string;
  targetLang: string;
  sourceLang?: string;
  model?: string;
  regionOnly?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * POST изображения на эндпоинт /translate бэкенда.
 * Никогда не бросает исключение: транспортные/HTTP-ошибки превращаются в
 * TranslateResult с полем `error`, чтобы UI рендерил их единообразно.
 */
export async function translateImage(params: TranslateParams): Promise<TranslateResult> {
  const {
    backendUrl,
    blob,
    fileName = 'image.png',
    targetLang,
    sourceLang = 'auto',
    model,
    regionOnly = false,
    timeoutMs = 90_000,
    signal,
  } = params;

  const form = new FormData();
  form.append('file', blob, fileName);
  form.append('target_lang', targetLang);
  form.append('source_lang', sourceLang);
  if (model) form.append('model', model);
  form.append('region_only', regionOnly ? 'true' : 'false');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const res = await fetch(`${backendUrl.replace(/\/$/, '')}/translate`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        detail = body?.detail ?? body?.error ?? detail;
      } catch {
        /* оставляем текст статуса HTTP */
      }
      return errorResult(detail);
    }

    return (await res.json()) as TranslateResult;
  } catch (e: unknown) {
    const msg = e instanceof Error && e.name === 'AbortError' ? 'Request timed out' : String(e);
    return errorResult(msg);
  } finally {
    clearTimeout(timer);
  }
}

/** GET /health — используется в Настройках для проверки соединения. */
export async function checkHealth(backendUrl: string, timeoutMs = 5_000): Promise<{ ok: boolean; info?: unknown; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${backendUrl.replace(/\/$/, '')}/health`, { signal: controller.signal });
    const info = await res.json();
    return { ok: res.ok, info };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function errorResult(detail: string): TranslateResult {
  return {
    source_text: '',
    translation: '',
    model: 'n/a',
    latency_ms: 0,
    error: detail,
  };
}
