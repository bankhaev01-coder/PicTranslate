import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, STORAGE_KEY } from './constants';
import type { Settings } from './types';

export async function getSettings(): Promise<Settings> {
  const raw = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as
    | (Partial<Settings> & { mtFallback?: boolean })
    | undefined;
  const settings: Settings = { ...DEFAULT_SETTINGS, ...raw };
  let dirty = false;

  // Миграция устаревшей модели Gemini
  if (settings.geminiModel === 'gemini-1.5-flash') {
    settings.geminiModel = 'gemini-3.8-flash';
    dirty = true;
  }

  // Миграция v0.1 → v0.2: булев mtFallback заменён парой externalMt + externalMtPriority.
  if (raw?.mtFallback !== undefined) {
    if (raw.externalMt === undefined) {
      settings.externalMt = raw.mtFallback ? 'google' : 'off';
      settings.externalMtPriority = raw.mtFallback ? 'fallback' : 'prefer';
    }
    delete (settings as Settings & { mtFallback?: boolean }).mtFallback;
    dirty = true;
  }

  if (dirty) void browser.storage.local.set({ [STORAGE_KEY]: settings });

  return settings;
}


export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await browser.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}
