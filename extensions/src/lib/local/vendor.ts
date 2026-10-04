import { browser } from 'wxt/browser';
import type { VendorManifest } from './registry';
import { listDownloadedOcrModels } from './ocrModels';

let cached: VendorManifest | null | undefined;

/**
 * Определить полностью офлайновый пакет ассетов, собранный `npm run vendor`.
 * Возвращает null, если public/vendor.json отсутствует; локальные вызывающие
 * должны падать явно, а не откатываться на CDN.
 */
async function getBundledManifest(baseUrl?: string): Promise<VendorManifest | null> {
  if (cached !== undefined) return cached;
  try {
    // У типа WXT нет runtime.getURL, но в chrome.runtime он есть.
    const rt = browser.runtime as unknown as { getURL: (path: string) => string };
    const base = baseUrl ?? rt.getURL('/');
    const res = await fetch(new URL('vendor.json', base), { cache: 'no-cache' });
    if (!res.ok) {
      cached = null;
      return null;
    }
    const manifest = (await res.json()) as VendorManifest;
    manifest.baseUrl = manifest.baseUrl || base;
    cached = manifest;
    return manifest;
  } catch {
    cached = null;
    return null;
  }
}

/** Тестовый шов: сбросить мемоизированный манифест. */
export function _resetVendorCache(): void {
  cached = undefined;
}

/** Bundled manifest is immutable; installed models are refreshed across options/offscreen contexts. */
export async function getVendorManifest(baseUrl?: string): Promise<VendorManifest | null> {
  const bundled = await getBundledManifest(baseUrl);
  if (!bundled) return null; // Downloaded data cannot replace the worker/core asset pack.
  const installed = await listDownloadedOcrModels();
  return { ...bundled,
    ocrLangs: [...new Set([...bundled.ocrLangs, ...installed.map(model => model.id)])],
    bundledOcrLangs: [...bundled.ocrLangs],
    ocrModelRevision: installed.map(model => `${model.id}:${model.installedAt}`).join('|'),
  };
}
