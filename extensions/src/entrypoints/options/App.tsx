import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { checkHealth } from '@/lib/api';
import { LANGUAGES, MODELS } from '@/lib/constants';
import { getSettings, saveSettings } from '@/lib/storage';
import { detectLang } from '@/lib/i18n';
import i18n from '@/lib/i18n';
import AiSection from './AiSection';
import LocalSection from './LocalSection';
import type { Settings } from '@/lib/types';

type ConnState = { state: 'idle' | 'testing' | 'ok' | 'fail'; detail?: string };

export default function App() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [conn, setConn] = useState<ConnState>({ state: 'idle' });

  useEffect(() => {
    void getSettings().then(setSettings);
  }, []);

  if (!settings) return <div className="page">{t('common.loading')}</div>;

  const patch = (p: Partial<Settings>) => {
    setSettings({ ...settings, ...p });
    setSaved(false);
  };

  const save = async () => {
    const next = await saveSettings(settings);
    setSettings(next);
    setSaved(true);
    // применить язык интерфейса сразу
    const lng = detectLang(next.uiLang);
    if (i18n.isInitialized && i18n.language !== lng) await i18n.changeLanguage(lng);
  };

  const testConnection = async () => {
    setConn({ state: 'testing' });
    const res = await checkHealth(settings.backendUrl);
    setConn(
      res.ok
        ? { state: 'ok', detail: JSON.stringify(res.info) }
        : { state: 'fail', detail: res.error },
    );
  };

  return (
    <div className="page">
      <h1>{t('options.title')}</h1>

      {/* ── движок ── */}
      <section className="card">
        <h2>{t('options.engine')}</h2>
        <div className="row engine-row">
          <label className="checkbox">
            <input
              type="radio"
              name="engine"
              checked={settings.engine === 'ai'}
              onChange={() => patch({ engine: 'ai' })}
            />
            {t('options.engineAi')}
          </label>
          <label className="checkbox">
            <input
              type="radio"
              name="engine"
              checked={settings.engine === 'local'}
              onChange={() => patch({ engine: 'local' })}
            />
            {t('options.engineLocal')}
          </label>
          <label className="checkbox">
            <input
              type="radio"
              name="engine"
              checked={settings.engine === 'backend'}
              onChange={() => patch({ engine: 'backend' })}
            />
            {t('options.engineBackend')}
          </label>
        </div>
        <div className="hint">{t('options.engineHint')}</div>
      </section>

      {settings.engine === 'ai' && <AiSection settings={settings} patch={patch} />}

      {settings.engine === 'local' && (
        <LocalSection
          settings={settings}
          patch={patch}
        />
      )}

      {/* ── backend (необязательный движок) ── */}
      {settings.engine === 'backend' && (
        <section className="card">
          <h2>{t('options.backend')}</h2>
          <div className="field">
            <label htmlFor="backendUrl">{t('options.backendUrl')}</label>
            <div className="row">
              <input
                id="backendUrl"
                type="url"
                value={settings.backendUrl}
                onChange={(e) => patch({ backendUrl: e.target.value })}
                placeholder="http://127.0.0.1:8000"
              />
              <button onClick={testConnection} disabled={conn.state === 'testing'}>
                {t('options.testConnection')}
              </button>
            </div>
            {conn.state === 'ok' && (
              <div className="status ok">
                ✓ {t('options.connectionOk')} — {conn.detail}
              </div>
            )}
            {conn.state === 'fail' && (
              <div className="status fail">
                ✕ {t('options.connectionFail')} — {conn.detail}
              </div>
            )}
            <div className="privacy">{t('options.privacy')}</div>
          </div>
        </section>
      )}

      {/* ── модель и языки ── */}
      <section className="card">
        <h2>{t('common.settings')}</h2>

        {settings.engine === 'backend' && (
          <div className="field">
            <label htmlFor="model">{t('options.model')}</label>
            <select
              id="model"
              value={settings.model}
              onChange={(e) => patch({ model: e.target.value as Settings['model'] })}
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.hint}
                </option>
              ))}
            </select>
            <div className="hint">{t('options.modelHint')}</div>
          </div>
        )}

        <div className="field">
          <label htmlFor="targetLang">{t('options.targetLang')}</label>
          <select id="targetLang" value={settings.targetLang} onChange={(e) => patch({ targetLang: e.target.value })}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="sourceLang">{t('options.sourceLang')}</label>
          <select id="sourceLang" value={settings.sourceLang} onChange={(e) => patch({ sourceLang: e.target.value })}>
            <option value="auto">{t('options.auto')}</option>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="uiLang">{t('options.uiLang')}</label>
          <select
            id="uiLang"
            value={settings.uiLang}
            onChange={(e) => patch({ uiLang: e.target.value as Settings['uiLang'] })}
          >
            <option value="auto">{t('options.uiAuto')}</option>
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="minImageSize">{t('options.minImageSize')}</label>
          <input
            id="minImageSize"
            type="number"
            min={0}
            max={2000}
            value={settings.minImageSize}
            onChange={(e) => patch({ minImageSize: Number(e.target.value) || 0 })}
          />
          <div className="hint">{t('options.minImageSizeHint')}</div>
        </div>

        <div className="field">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.autoScan}
              onChange={(e) => patch({ autoScan: e.target.checked })}
            />
            {t('options.autoScan')}
          </label>
        </div>
      </section>

      <div className="footer">
        <button className="primary" onClick={save}>
          {t('common.save')}
        </button>
        {saved && <span className="status ok">{t('common.saved')}</span>}
      </div>
    </div>
  );
}
