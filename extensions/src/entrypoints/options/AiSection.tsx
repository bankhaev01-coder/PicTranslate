import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { browser } from 'wxt/browser';
import type { Settings } from '@/lib/types';
import { groqVisionPreset } from '@/lib/ai/presets';

interface Props {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}

export default function AiSection({ settings, patch }: Props) {
  const { t } = useTranslation();
  const [permStatus, setPermStatus] = useState<string | null>(null);

  const selectedProvider =
    settings.model === 'openai'
      ? 'openai'
      : settings.model === 'custom'
        ? 'custom'
        : settings.model === 'pollinations'
          ? 'pollinations'
          : settings.model === 'openrouter'
            ? 'openrouter'
            : 'gemini';

  const requestCustomPermission = async () => {
    try {
      const urlStr = settings.customAiBaseUrl.trim();
      if (!urlStr) {
        setPermStatus(t('options.permUrlRequired'));
        return;
      }
      const parsed = new URL(urlStr);
      const origin = `${parsed.protocol}//${parsed.host}/*`;
      const granted = await browser.permissions.request({
        origins: [origin],
      });
      setPermStatus(granted ? t('options.permGranted') : t('options.permDenied'));
    } catch (e) {
      setPermStatus(`${t('options.permError')}: ${String(e)}`);
    }
  };

  return (
    <>
      <section className="card">
        <h2>{t('options.engineAi')}</h2>

        <div className="field">
          <label htmlFor="aiProvider">{t('options.aiProvider')}</label>
          <select
            id="aiProvider"
            value={selectedProvider}
            onChange={(e) => patch({ model: e.target.value as Settings['model'] })}
          >
            <option value="gemini">{t('options.aiGemini')}</option>
            <option value="openai">{t('options.aiOpenai')}</option>
            <option value="pollinations">{t('options.aiPollinations')}</option>
            <option value="openrouter">{t('options.aiOpenrouter')}</option>
            <option value="custom">{t('options.aiCustom')}</option>
          </select>
        </div>

        <div className="field">
          <button type="button" onClick={() => { patch(groqVisionPreset(settings)); setPermStatus(null); }}>
            {t('options.groqPreset')}
          </button>
          <div className="hint">{t('options.groqPresetHint')}</div>
        </div>

        {selectedProvider === 'gemini' && (
          <>
            <div className="field">
              <label htmlFor="geminiModel">{t('options.aiModel')}</label>
              <input
                id="geminiModel"
                type="text"
                value={settings.geminiModel}
                onChange={(e) => patch({ geminiModel: e.target.value })}
                placeholder="gemini-3.8-flash"
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

        {selectedProvider === 'openai' && (
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

        {selectedProvider === 'pollinations' && (
          <>
            <div className="field">
              <label htmlFor="pollinationsModel">{t('options.aiModel')}</label>
              <input
                id="pollinationsModel"
                type="text"
                value={settings.pollinationsModel}
                onChange={(e) => patch({ pollinationsModel: e.target.value })}
                placeholder="openai"
                spellCheck={false}
              />
              <div className="hint">{t('options.pollinationsModelHint')}</div>
            </div>
            <div className="field">
              <label htmlFor="pollinationsKey">{t('options.aiKey')}</label>
              <input
                id="pollinationsKey"
                type="password"
                value={settings.pollinationsApiKey}
                onChange={(e) => patch({ pollinationsApiKey: e.target.value })}
                placeholder="sk_… / pk_…"
                autoComplete="off"
                spellCheck={false}
              />
              <div className="hint">{t('options.pollinationsKeyHint')}</div>
            </div>
          </>
        )}

        {selectedProvider === 'openrouter' && (
          <>
            <div className="field">
              <label htmlFor="openrouterModel">{t('options.aiModel')}</label>
              <input
                id="openrouterModel"
                type="text"
                value={settings.openrouterModel}
                onChange={(e) => patch({ openrouterModel: e.target.value })}
                placeholder="openrouter/free"
                spellCheck={false}
              />
              <div className="hint">{t('options.openrouterModelHint')}</div>
            </div>
            <div className="field">
              <label htmlFor="openrouterKey">{t('options.aiKey')}</label>
              <input
                id="openrouterKey"
                type="password"
                value={settings.openrouterApiKey}
                onChange={(e) => patch({ openrouterApiKey: e.target.value })}
                placeholder="sk-or-…"
                autoComplete="off"
                spellCheck={false}
              />
              <div className="hint">{t('options.openrouterKeyHint')}</div>
            </div>
          </>
        )}

        {selectedProvider === 'custom' && (
          <>
            <div className="field">
              <label htmlFor="customAiBaseUrl">{t('options.aiBaseUrl')}</label>
              <div className="row">
                <input
                  id="customAiBaseUrl"
                  type="url"
                  value={settings.customAiBaseUrl}
                  onChange={(e) => patch({ customAiBaseUrl: e.target.value })}
                  placeholder="http://localhost:11434/v1"
                  spellCheck={false}
                />
                <button type="button" onClick={requestCustomPermission}>
                  {t('options.requestPermission')}
                </button>
              </div>
              {permStatus && <div className="status">{permStatus}</div>}
              <div className="hint">{t('options.customAiBaseUrlHint')}</div>
            </div>
            <div className="field">
              <label htmlFor="customAiModel">{t('options.aiModel')}</label>
              <input
                id="customAiModel"
                type="text"
                value={settings.customAiModel}
                onChange={(e) => patch({ customAiModel: e.target.value })}
                placeholder="llama3.2-vision / qwen2.5-vl"
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label htmlFor="customAiKey">{t('options.aiKey')}</label>
              <input
                id="customAiKey"
                type="password"
                value={settings.customAiApiKey}
                onChange={(e) => patch({ customAiApiKey: e.target.value })}
                placeholder="sk-… (optional)"
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
