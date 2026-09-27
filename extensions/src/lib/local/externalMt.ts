/**
 * Внешний MT для автономного движка (engine:'local').
 *
 * Используется, когда пользователь выбрал внешнего переводчика в настройках:
 * либо первым шагом (`externalMtPriority: 'prefer'`), либо только при сбое
 * локальной NMT-модели (`'fallback'`). На внешний сервис уходит только
 * распознанный ТЕКСТ (без изображения); оба провайдера бесплатны и работают
 * без API-ключа.
 *
 * Чистый модуль без DOM — юнит-тестируется в Node (fetch инжектится).
 */
import { chunkText } from './text';

/** Провайдеры внешнего перевода, доступные без API-ключа. */
export type MtProvider = 'google' | 'yandex';

export interface ExternalMtOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Инжекция fetch для тестов; по умолчанию — глобальный fetch. */
  fetchImpl?: typeof fetch;
  /** Максимальная длина фрагмента (дефолт как у локального chunkText). */
  chunkMaxLen?: number;
  /** Какой внешний сервис использовать (по умолчанию Google). */
  provider?: MtProvider;
}

export interface ExternalMtResult {
  translation: string;
  /** Язык, определённый внешней службой (только при sourceLang 'auto'). */
  detected?: string;
}

const GTX_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

/** Нормализовать код языка настроек к кодам Google (регион отбрасывается). */
export function toGoogleLang(lang: string): string {
  const base = lang.split('-')[0]?.split('_')[0]?.toLowerCase() ?? '';
  if (base === 'zh') return 'zh-CN';
  if (base === 'iw') return 'he';
  return base || 'auto';
}

export interface GtxParsed {
  translation: string;
  sourceLang?: string;
}

/**
 * Разобрать ответ gtx `translate_a/single`:
 * `[[["перевод","исходник",...],...], null, "en", ...]` —
 * склеить первые элементы предложений, язык-источник взять из индекса 2.
 */
export function parseGtxResponse(json: unknown): GtxParsed {
  if (!Array.isArray(json)) throw new Error('gtx: unexpected response shape');
  const sentences: unknown = json[0];
  const translation = Array.isArray(sentences)
    ? sentences.map((s) => (Array.isArray(s) ? String(s[0] ?? '') : '')).join('')
    : '';
  const meta: unknown = json[2];
  const sourceLang = typeof meta === 'string' ? meta : undefined;
  return { translation, sourceLang };
}

/** Собрать URL gtx-запроса для одного фрагмента (удобно для тестов). */
export function buildGtxUrl(text: string, source: string, target: string): string {
  const params = new URLSearchParams({
    client: 'gtx',
    ie: 'UTF-8',
    oe: 'UTF-8',
    sl: toGoogleLang(source),
    tl: toGoogleLang(target),
    dt: 't',
    q: text,
  });
  return `${GTX_ENDPOINT}?${params.toString()}`;
}

/* ── Яндекс.Переводчик (tr.json) ──────────────────────────── */

const YANDEX_ENDPOINT = 'https://translate.yandex.net/api/v1/tr.json/translate';

/** Нормализовать код языка к кодам Яндекс.Переводчика (регион отбрасывается). */
export function toYandexLang(lang: string): string {
  const base = lang.split('-')[0]?.split('_')[0]?.toLowerCase() ?? '';
  if (base === 'iw') return 'he';
  return base;
}

export interface YandexRequest {
  url: string;
  body: URLSearchParams;
}

/**
 * Запрос Яндекс.Переводчика для одного фрагмента (POST, form-urlencoded).
 * `source_lang` не отправляется при 'auto' — сервис сам определит язык
 * и вернёт его в поле `lang` ответа.
 */
export function buildYandexRequest(
  text: string,
  source: string,
  target: string,
  requestId: string,
): YandexRequest {
  const query = new URLSearchParams({ srv: 'android', id: requestId });
  const body = new URLSearchParams({ text, target_lang: toYandexLang(target) });
  const from = toYandexLang(source);
  if (from && from !== 'auto') body.set('source_lang', from);
  return { url: `${YANDEX_ENDPOINT}?${query.toString()}`, body };
}

export interface YandexParsed {
  translation: string;
  sourceLang?: string;
}

/**
 * Разобрать ответ tr.json: `{code:200, lang:'en-ru', text:['перевод']}`.
 * Ненулевой `code` — ошибка сервиса (лимит, неподдерживаемая пара и т.п.).
 */
export function parseYandexResponse(json: unknown): YandexParsed {
  if (!json || typeof json !== 'object') throw new Error('yandex: unexpected response shape');
  const data = json as { code?: number; lang?: string; text?: unknown };
  if (typeof data.code === 'number' && data.code !== 200) {
    throw new Error(`yandex: code ${data.code}`);
  }
  const translation = Array.isArray(data.text)
    ? data.text.map((t) => String(t ?? '')).join('')
    : '';
  const sourceLang = typeof data.lang === 'string' ? data.lang.split('-')[0] : undefined;
  return { translation, sourceLang };
}

/** Уникальный id запроса Яндекса: `<32 hex>-0-0` (формат их клиента). */
function yandexRequestId(): string {
  const raw =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(16)}${Math.floor(Math.random() * 1e16).toString(16)}`;
  return `${raw.replace(/[^a-f0-9]/gi, '')}-0-0`;
}

async function fetchGoogleChunk(
  text: string,
  source: string,
  target: string,
  options: ExternalMtOptions,
): Promise<GtxParsed> {
  const { signal, timeoutMs = 30_000, fetchImpl } = options;
  const fetchFn = fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const resp = await fetchFn(buildGtxUrl(text, source, target), { signal: controller.signal });
    if (!resp.ok) throw new Error(`gtx: HTTP ${resp.status}`);
    return parseGtxResponse(await resp.json());
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('gtx: request timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYandexChunk(
  text: string,
  source: string,
  target: string,
  options: ExternalMtOptions,
): Promise<YandexParsed> {
  const { signal, timeoutMs = 30_000, fetchImpl } = options;
  const fetchFn = fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  const { url, body } = buildYandexRequest(text, source, target, yandexRequestId());
  try {
    const resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`yandex: HTTP ${resp.status}`);
    return parseYandexResponse(await resp.json());
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('yandex: request timed out');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Один фрагмент через выбранного провайдера. */
async function fetchChunk(
  text: string,
  source: string,
  target: string,
  options: ExternalMtOptions,
): Promise<GtxParsed | YandexParsed> {
  return (options.provider ?? 'google') === 'yandex'
    ? fetchYandexChunk(text, source, target, options)
    : fetchGoogleChunk(text, source, target, options);
}

/**
 * Перевести длинный OCR-текст через внешний MT с разбивкой на фрагменты.
 * Бросает Error с читаемым сообщением — вызывающий решает, как показать сбой.
 */
export async function translateLongText(
  text: string,
  sourceLang: string,
  targetLang: string,
  options: ExternalMtOptions = {},
): Promise<ExternalMtResult> {
  const chunks = chunkText(text, options.chunkMaxLen ?? 400);
  const parts: string[] = [];
  let detected: string | undefined;
  for (const chunk of chunks) {
    const { translation, sourceLang: sl } = await fetchChunk(chunk, sourceLang, targetLang, options);
    parts.push(translation);
    if (!detected && sl && sourceLang === 'auto') detected = sl;
  }
  return { translation: parts.join('\n'), detected };
}
