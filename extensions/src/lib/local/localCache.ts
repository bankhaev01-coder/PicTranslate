/**
 * Кеш результатов локального перевода (Cache Storage) — расширение-сторона
 * файлового кеша бэкенда. Ключ = sha256(изображение)+языки+движок+область.
 */
export const OCR_PIPELINE_VERSION = 'v4';
const CACHE_NAME = `te-local-results-${OCR_PIPELINE_VERSION}`;
/** Общий префикс всех версий: clear сносит и устаревшие кэши пайплайна. */
const CACHE_PREFIX = 'te-local-results-';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней, зеркалит backend CACHE_TTL_SECONDS

interface Stored {
  savedAt: number;
  payload: unknown;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // TS ≥5.7: Uint8Array<ArrayBufferLike> vs BufferSource — каст здесь безопасен
  // (вызывающие всегда передают обычное view поверх ArrayBuffer).
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function requestFor(scope: string, key: string): Request {
  return new Request(`https://te.local/${scope}/${key}`);
}

/** Всё, что влияет на распознанный текст или перевод и обязано войти в ключ. */
export interface LocalCacheKeyInput {
  imageHash: string;
  regionOnly: boolean;
  sourceLang: string;
  targetLang: string;
  ocrLangs: string[];
  ocrQuality: string;
  ocrMinConfidence: number;
  useNativeHost: boolean;
  cloudOcr: boolean;
  cloudTranslate: boolean;
  externalMt: string;
  externalMtPriority: string;
}

/**
 * Ключ кеша результата. В ключ обязан входить каждый параметр, меняющий текст
 * или перевод: смена провайдера внешнего MT, приоритета, качества OCR или
 * языка не должна отдавать чужой результат из кеша. Облачный OCR относится
 * только к кропу области (regionOnly+cloudOcr): получает свой тег `cloud`
 * (`cloudTr`, если сервер сразу перевёл), чтобы серверный и локальный
 * результаты не смешивались. `scope` (reg/full) разделяет кроп и полный скан.
 *
 * Чистая функция — юнит-тестируется.
 */
export function buildLocalCacheKey(input: LocalCacheKeyInput): { scope: string; cacheId: string } {
  const cloudTag =
    input.regionOnly && input.cloudOcr ? (input.cloudTranslate ? 'cloudTr' : 'cloud') : '';
  const providerTag =
    input.externalMt === 'off' ? 'off' : `${input.externalMt}:${input.externalMtPriority}`;
  const ocrTag = `${input.ocrQuality}:${input.ocrMinConfidence}:${
    input.useNativeHost ? 'native' : 'tesseract'
  }`;
  const cacheId = [
    input.targetLang,
    input.sourceLang,
    input.ocrLangs.join('+'),
    ocrTag,
    providerTag,
    cloudTag,
    input.imageHash,
  ]
    .filter((part) => part.length > 0)
    .join(':');
  return { scope: input.regionOnly ? 'reg' : 'full', cacheId };
}

export async function localCacheGet<T>(scope: string, key: string): Promise<T | null> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(requestFor(scope, key));
    if (!res) return null;
    const stored = (await res.json()) as Stored;
    if (Date.now() - stored.savedAt > TTL_MS) {
      await cache.delete(requestFor(scope, key));
      return null;
    }
    return stored.payload as T;
  } catch {
    return null;
  }
}

export async function localCacheSet(scope: string, key: string, payload: unknown): Promise<void> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const body: Stored = { savedAt: Date.now(), payload };
    await cache.put(
      requestFor(scope, key),
      new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }),
    );
  } catch {
    /* quota/private-mode — кеш по возможности */
  }
}

export async function localCacheClear(): Promise<void> {
  try {
    const names = await caches.keys();
    await Promise.all(
      names.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => caches.delete(name)),
    );
  } catch {
    /* не страшно */
  }
}
