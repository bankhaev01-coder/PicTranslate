import { browser } from 'wxt/browser';
import type { Msg } from './types';

/** Promise-обёртка runtime.sendMessage к background-сервис-воркеру. */
export async function sendToBackground<T = unknown>(msg: Msg): Promise<T> {
  return (await browser.runtime.sendMessage(msg)) as T;
}

/** Promise-обёртка tabs.sendMessage к контент-скрипту. */
export async function sendToTab<T = unknown>(tabId: number, msg: Msg): Promise<T> {
  return (await browser.tabs.sendMessage(tabId, msg)) as T;
}

/** Превратить Blob в data URL (для передачи байтов изображения через messaging). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
