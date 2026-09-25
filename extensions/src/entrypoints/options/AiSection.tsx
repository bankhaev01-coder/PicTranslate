import { useTranslation } from 'react-i18next';
import type { Settings } from '@/lib/types';

interface Props {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}

/**
 * «AI Vision (без сервера)» — движок по умолчанию. Запросы идут напрямую из
 * расширения к vendor API; промежуточного сервера нет. API-ключ хранится
 * только в локальном storage расширения.
 */
export default function AiSection({ settings, patch }: Props) {
  const { t } = useTranslation();
  const isOpenAI = settings.model === 'openai';

  return (
    <>
      <section className="card">
        <h2>{t('options.engineAi')}</h2>

        <div className="field">
          <label htmlFor="aiProvider">{t('options.aiProvider')}</label>
          <select
            id="aiProvider"
            value={isOpenAI ? 'openai' : 'gemini'}
            onChange={(e) => patch({ model: e.target.value === 'openai' ? 'openai' : 'gemini' })}
          >
            <option value="gemini">{t('options.aiGemini')}</option>
            <option value="openai">{t('options.aiOpenai')}</option>
          </select>
        </div>

        {!isOpenAI && (
          <>
            <div className="field">
              <label htmlFor="geminiModel">{t('options.aiModel')}</label>
              <input
                id="geminiModel"
                type="text"
                value={settings.geminiModel}
                onChange={(e) => patch({ geminiModel: e.target.value })}
                placeholder="gemini-1.5-flash"
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label htmlFor="geminiKey">{t('options.aiKey')}</label>
              <input
                id="geminiKey"
                type="password"
                value={settings.geminiApiKey}
                onChange={(e) => patch({ geminiApiKey: e.target.value })}
                placeholder="AIza…"
                autoComplete="off"
                spellCheck={false}
              />
              <div className="hint">{t('options.aiKeyHint')}</div>
            </div>
          </>
        )}

        {isOpenAI && (
          <>
            <div className="field">
              <label htmlFor="openaiBaseUrl">{t('options.aiBaseUrl')}</label>
              <input
                id="openaiBaseUrl"
                type="url"
                value={settings.openaiBaseUrl}
                onChange={(e) => patch({ openaiBaseUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label htmlFor="openaiModel">{t('options.aiModel')}</label>
              <input
                id="openaiModel"
                type="text"
                value={settings.openaiModel}
                onChange={(e) => patch({ openaiModel: e.target.value })}
                placeholder="gpt-4o"
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label htmlFor="openaiKey">{t('options.aiKey')}</label>
              <input
                id="openaiKey"
                type="password"
                value={settings.openaiApiKey}
                onChange={(e) => patch({ openaiApiKey: e.target.value })}
                placeholder="sk-…"
                autoComplete="off"
                spellCheck={false}
              />
              <div className="hint">{t('options.aiKeyHint')}</div>
            </div>
          </>
        )}

        <div className="privacy">{t('options.aiPrivacy')}</div>
      </section>
    </>
  );
}
