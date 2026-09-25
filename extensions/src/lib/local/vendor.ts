import { browser } from 'wxt/browser';
import type { VendorManifest } from './registry';

let cached: VendorManifest | null | undefined;

/**
 * Определить полностью офлайновый пакет ассетов, собранный `npm run vendor`.
 * Возвращает null, если public/vendor.json отсутствует; локальные вызывающие
 * должны падать явно, а не откатываться на CDN.
 */
export async function getVendorManifest(baseUrl?: string): Promise<VendorManifest | null> {
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
