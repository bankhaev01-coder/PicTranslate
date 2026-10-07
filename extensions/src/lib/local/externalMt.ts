/**
 * Внешний MT для автономного движка (engine:'local').
 *
 * Используется, когда пользователь выбрал внешнего переводчика в настройках:
 * либо первым шагом (`externalMtPriority: 'prefer'`), либо только при сбое
 * локальной NMT-модели (`'fallback'`). На внешний сервис уходит только
 * распознанный ТЕКСТ (без изображения); Google (gtx) и неофициальный Яндекс
 * (tr.json) работают без API-ключа, Яндекс.Облако v2 требует ключ сервисного
 * аккаунта.
 *
 * Чистый модуль без DOM — юнит-тестируется в Node (fetch инжектится).
 */
import { chunkText } from './text';

/** Провайдеры внешнего перевода. `yandex` — неофициальный tr.json мобильного
 * клиента (жив на 29.09.2026, но без гарантий); `yandex-cloud` — официальный
 * API Яндекс.Облака v2 с API-ключом. */
export type MtProvider = 'google' | 'yandex' | 'yandex-cloud';

export interface ExternalMtOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Инжекция fetch для тестов; по умолчанию — глобальный fetch. */
  fetchImpl?: typeof fetch;
  /** Максимальная длина фрагмента (дефолт как у локального chunkText). */
  chunkMaxLen?: number;
  /** Какой внешний сервис использовать (по умолчанию Google). */
  provider?: MtProvider;
  /**
   * Яндекс.Облако Translate v2: API-ключ сервисного аккаунта (`AQ...`).
   * Без него провайдер 'yandex-cloud' недоступен. Folder id НЕ нужен:
   * используется бессерверный эндпоинт detect без folderId.
   */
  yandexCloudApiKey?: string;
}

export interface ExternalMtResult {
  translation: string;
  /** Язык, определённый внешней службой (только при sourceLang 'auto'). */
  detected?: string;
}

/* ── Таймаут + внешняя отмена ─────────────────────────────── */

interface LinkedAbort {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
}

/**
 * Объединить таймаут и внешний signal в один AbortSignal.
 * Раньше слушатель `abort` на внешнем signal не снимался (утечка на каждый
 * фрагмент), уже отменённый signal игнорировался, а отмена пользователем
 * выдавалась за «request timed out».
 */
function linkAbort(signal: AbortSignal | undefined, timeoutMs: number): LinkedAbort {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** Читаемая ошибка прерванного запроса: таймаут или отмена вызывающим. */
function abortedError(prefix: string, link: LinkedAbort): Error {
  return new Error(link.timedOut() ? `${prefix}: request timed out` : `${prefix}: request cancelled`);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
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
  const link = linkAbort(signal, timeoutMs);
  try {
    if (link.signal.aborted) throw abortedError('gtx', link);
    const resp = await fetchFn(buildGtxUrl(text, source, target), { signal: link.signal });
    if (!resp.ok) throw new Error(`gtx: HTTP ${resp.status}`);
    return parseGtxResponse(await resp.json());
  } catch (err: unknown) {
    if (isAbortError(err)) throw abortedError('gtx', link);
    throw err;
  } finally {
    link.cleanup();
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
  const { url, body } = buildYandexRequest(text, source, target, yandexRequestId());
  const link = linkAbort(signal, timeoutMs);
  try {
    if (link.signal.aborted) throw abortedError('yandex', link);
    const resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: link.signal,
    });
    if (!resp.ok) throw new Error(`yandex: HTTP ${resp.status}`);
    return parseYandexResponse(await resp.json());
  } catch (err: unknown) {
    if (isAbortError(err)) throw abortedError('yandex', link);
    throw err;
  } finally {
    link.cleanup();
  }
}

/** Один фрагмент через выбранного провайдера. */
async function fetchChunk(
  text: string,
  source: string,
  target: string,
  options: ExternalMtOptions,
): Promise<GtxParsed | YandexParsed> {
  const provider = options.provider ?? 'google';
  if (provider === 'yandex-cloud') return fetchYandexCloudChunk(text, source, target, options);
  return provider === 'yandex'
    ? fetchYandexChunk(text, source, target, options)
    : fetchGoogleChunk(text, source, target, options);
}

/* ── Яндекс.Облако Translate v2 (официальный API, API-ключ `AQ...`) ──── */
/* Документация: https://yandex.cloud/ru/docs/translate/api-ref/translation/translate */

const YANDEX_CLOUD_ENDPOINT = 'https://translate.api.cloud.yandex.net/translate/v2/translate';

/** Код языка настроек → код Яндекс.Облака (BCP-47, регион отбрасывается). */
export function toYandexCloudLang(lang: string): string {
  const base = lang.split('-')[0]?.split('_')[0]?.toLowerCase() ?? '';
  if (base === 'iw') return 'he';
  return base || 'auto';
}

export interface YandexCloudTranslated {
  text: string;
  detectedLanguageCode?: string;
}

export interface YandexCloudResponse {
  translations?: YandexCloudTranslated[];
}

/** Разобрать ответ v2/translate: склеить `translations[].text`, язык — из первого. */
export function parseYandexCloudResponse(json: unknown): GtxParsed {
  const o = json as YandexCloudResponse | null;
  const list = Array.isArray(o?.translations) ? o.translations : [];
  const translation = list.map((t) => String(t?.text ?? '')).join('');
  const sourceLang = list[0]?.detectedLanguageCode?.split('-')[0];
  if (!translation) throw new Error('yandex-cloud: empty translations');
  return { translation, sourceLang };
}

/** Один фрагмент через Яндекс.Облако v2 (POST JSON, ключ в `Authorization: Api-Key`). */
async function fetchYandexCloudChunk(
  text: string,
  source: string,
  target: string,
  options: ExternalMtOptions,
): Promise<GtxParsed> {
  const { signal, timeoutMs = 30_000, fetchImpl, yandexCloudApiKey } = options;
  if (!yandexCloudApiKey) throw new Error('yandex-cloud: API key is not configured');
  const fetchFn = fetchImpl ?? fetch;
  const body = {
    texts: [text],
    targetLanguageCode: toYandexCloudLang(target),
    ...(toYandexCloudLang(source) === 'auto'
      ? {}
      : { sourceLanguageCode: toYandexCloudLang(source) }),
  };
  const link = linkAbort(signal, timeoutMs);
  try {
    if (link.signal.aborted) throw abortedError('yandex-cloud', link);
    const resp = await fetchFn(YANDEX_CLOUD_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Api-Key ${yandexCloudApiKey}`,
      },
      body: JSON.stringify(body),
      signal: link.signal,
    });
    if (!resp.ok) throw new Error(`yandex-cloud: HTTP ${resp.status}`);
    return parseYandexCloudResponse(await resp.json());
  } catch (err: unknown) {
    if (isAbortError(err)) throw abortedError('yandex-cloud', link);
    throw err;
  } finally {
    link.cleanup();
  }
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
    // Отмена между фрагментами: не отправляем оставшиеся запросы.
    if (options.signal?.aborted) throw new Error('external MT: request cancelled');
    const { translation, sourceLang: sl } = await fetchChunk(chunk, sourceLang, targetLang, options);
    parts.push(translation);
    if (!detected && sl && sourceLang === 'auto') detected = sl;
  }
  return { translation: parts.join('\n'), detected };
}
