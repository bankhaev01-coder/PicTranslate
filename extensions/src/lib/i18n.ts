import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '@/locales/en.json';
import ru from '@/locales/ru.json';
import { getSettings } from './storage';

export type UiLang = 'ru' | 'en';

export function detectLang(setting: 'auto' | UiLang): UiLang {
  if (setting !== 'auto') return setting;
  return (navigator.language || 'en').toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/**
 * Инициализировать i18next. Без обращения к chrome.storage — функция безопасна
 * и в offscreen-документе (там storage недоступен). Язык: параметр или авто.
 */
export async function initI18n(lang: 'auto' | UiLang = 'auto'): Promise<typeof i18n> {
  const lng = detectLang(lang);

  if (i18n.isInitialized) {
    if (i18n.language !== lng) await i18n.changeLanguage(lng);
    return i18n;
  }

  await i18n.use(initReactI18next).init({
    resources: {
      en: { translation: en },
      ru: { translation: ru },
    },
    lng,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
  return i18n;
}

/** Вариант для контекстов со storage (popup/options/content): язык из настроек. */
export async function initI18nFromSettings(): Promise<typeof i18n> {
  const settings = await getSettings();
  return initI18n(settings.uiLang);
}

export default i18n;
