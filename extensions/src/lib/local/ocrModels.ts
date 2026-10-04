import { listOcrLangs } from './registry';

/** Separate from disposable OCR/translation results. Downloads require a user gesture. */
const CACHE = 'te-installed-ocr-models-v1';
export const OCR_MODEL_ORIGIN = 'https://tessdata.projectnaptha.com/*';
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_RAW_BYTES = 128 * 1024 * 1024;
export interface InstalledOcrModel { id: string; bytes: number; installedAt: string }
function known(id: string): void {
  if (!listOcrLangs().some(lang => lang.id === id)) throw new Error('Unknown OCR language');
}
function request(id: string): Request { return new Request(`https://ocr-models.invalid/${id}`); }

async function boundedBytes(response: Response, max: number): Promise<Uint8Array> {
  if (!response.body) throw new Error('Empty model response');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > max) { await reader.cancel(); throw new Error('OCR model exceeds size limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}
export function validateTraineddata(bytes: Uint8Array): void {
  if (bytes.length < 12) throw new Error('Invalid traineddata file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getInt32(0, true); const headerSize = 4 + count * 8;
  if (count < 1 || count > 128 || headerSize >= bytes.length) throw new Error('Invalid traineddata header');
  let found = false;
  for (let i = 0; i < count; i++) {
    const offset = view.getBigInt64(4 + i * 8, true);
    if (offset === -1n) continue;
    if (offset < BigInt(headerSize) || offset >= BigInt(bytes.length)) throw new Error('Invalid traineddata offset');
    found = true;
  }
  if (!found) throw new Error('Empty traineddata file');
}
async function unpack(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] !== 31 || bytes[1] !== 139) throw new Error('Expected gzip OCR model');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  const raw = await boundedBytes(new Response(stream), MAX_RAW_BYTES);
  validateTraineddata(raw); return raw;
}
export async function listDownloadedOcrModels(): Promise<InstalledOcrModel[]> {
  const cache = await caches.open(CACHE); const models: InstalledOcrModel[] = [];
  for (const lang of listOcrLangs()) {
    const response = await cache.match(request(lang.id));
    if (response) models.push({ id: lang.id, bytes: Number(response.headers.get('x-model-bytes')), installedAt: response.headers.get('x-installed-at') ?? '' });
  }
  return models;
}
const pending = new Map<string, Promise<void>>();
export async function downloadOcrModel(id: string, onProgress?: (bytes: number) => void): Promise<void> {
  known(id);
  if (pending.has(id)) return pending.get(id);
  const task = (async () => {
    const response = await fetch(`https://tessdata.projectnaptha.com/4.0.0_best/${id}.traineddata.gz`, {
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`OCR download: HTTP ${response.status}`);
    const bytes = await boundedBytes(response, MAX_BYTES);
    onProgress?.(bytes.length);
    await unpack(bytes); // No status update or persistence for HTML/truncated/invalid files.
    const cache = await caches.open(CACHE);
    await cache.put(request(id), new Response(bytes as BodyInit, { headers: {
      'content-type': 'application/gzip', 'x-model-bytes': String(bytes.length), 'x-installed-at': new Date().toISOString(),
    } }));
  })();
  pending.set(id, task);
  try { await task; } finally { pending.delete(id); }
}

/** Tesseract.js v7 browser adapter uses idb-keyval's default DB/store.
 * Isolated bridge; traineddata is seeded under our explicit cachePath, never a remote fallback.
 */
function workerCache(id: string, data?: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('keyval-store', 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('keyval')) req.result.createObjectStore('keyval'); };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('OCR storage is blocked'));
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('keyval', 'readwrite'); const store = tx.objectStore('keyval');
      const key = `te-user-ocr/${id}.traineddata`;
      if (data) store.put(data, key); else store.delete(key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('OCR storage failed')); };
    };
  });
}
export async function seedDownloadedOcrModels(ids: string[]): Promise<void> {
  const cache = await caches.open(CACHE);
  for (const id of ids) {
    const response = await cache.match(request(id));
    if (response) await workerCache(id, await unpack(new Uint8Array(await response.arrayBuffer())));
  }
}
export async function removeOcrModel(id: string): Promise<void> {
  known(id);
  if (pending.has(id)) throw new Error('OCR model download is still running');
  // Delete worker copy first: a storage failure must not falsely report removal.
  if (typeof indexedDB !== 'undefined') await workerCache(id);
  const cache = await caches.open(CACHE); await cache.delete(request(id));
}
const SOURCE_CODES: Record<string, string[]> = {
  en: ['eng'], ru: ['rus'], ja: ['jpn', 'jpn_vert'], zh: ['chi_sim', 'chi_tra'],
  ko: ['kor'], de: ['deu'], fr: ['fra'], es: ['spa'], it: ['ita'],
};
export function resolveOcrLanguages(requested: string[], available: string[], source: string): string[] {
  const missing = requested.filter(id => !available.includes(id));
  if (missing.length) throw new Error(`OCR models not installed: ${missing.join(', ')}. Download them in Settings → OCR languages.`);
  const relevant = SOURCE_CODES[source];
  const selected = relevant ? requested.filter(id => relevant.includes(id)) : requested;
  if (!selected.length) throw new Error(`No selected OCR model for ${source}. Install and select its language in Settings → OCR languages.`);
  return selected;
}
