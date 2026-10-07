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
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // Внешняя отмена: если сигнал уже отменён, addEventListener никогда не сработает,
  // поэтому отменяем сразу. Слушатель снимаем в finally, чтобы не копить их на
  // долгоживущем сигнале.
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(`${backendUrl.replace(/\/$/, '')}/translate`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        detail = httpErrorDetail(await res.json(), detail);
      } catch {
        /* оставляем текст статуса HTTP */
      }
      return errorResult(detail);
    }

    return (await res.json()) as TranslateResult;
  } catch (e: unknown) {
    return errorResult(abortMessage(e, timedOut));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Текст ошибки для исключения fetch. Отмена пользователем больше не выдаётся
 * за таймаут. Чистая функция — юнит-тестируется.
 */
export function abortMessage(e: unknown, timedOut: boolean): string {
  const isAbort = e instanceof Error && e.name === 'AbortError';
  if (!isAbort) return String(e);
  return timedOut ? 'Request timed out' : 'Request cancelled';
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

/**
 * Человекочитаемая причина HTTP-ошибки бэкенда.
 *
 * FastAPI кладёт в `detail` строку, но на 422 (валидация) — массив объектов
 * `{loc, msg, type}`: без сериализации в UI уходило бесполезное `[object Object]`.
 * Пустые объект/массив и отсутствие полей дают `fallback` (обычно `HTTP <код>`).
 * Чистая функция — юнит-тестируется.
 */
export function httpErrorDetail(body: unknown, fallback: string): string {
  const record = (body ?? {}) as { detail?: unknown; error?: unknown };
  const raw = record.detail ?? record.error;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (raw && typeof raw === 'object') {
    try {
      const json = JSON.stringify(raw);
      if (json && json !== '{}' && json !== '[]') return json;
    } catch {
      /* циклическая ссылка в ответе — остаёмся на fallback */
    }
  }
  return fallback;
}
