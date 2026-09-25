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

/** Инициализировать i18next один раз (вызов безопасен из popup / options / content). */
export async function initI18n(): Promise<typeof i18n> {
  const settings = await getSettings();
  const lng = detectLang(settings.uiLang);

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

export default i18n;
