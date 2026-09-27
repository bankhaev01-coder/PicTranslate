/**
 * Кеш результатов локального перевода (Cache Storage) — расширение-сторона
 * файлового кеша бэкенда. Ключ = sha256(изображение)+языки+движок+область.
 */
export const OCR_PIPELINE_VERSION = 'v2';
const CACHE_NAME = `te-local-results-${OCR_PIPELINE_VERSION}`;
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
    await caches.delete(CACHE_NAME);
  } catch {
    /* не страшно */
  }
}
