import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { browser } from 'wxt/browser';
import { listOcrLangs, listPairs } from '@/lib/local/registry';
import { getVendorManifest } from '@/lib/local/vendor';
import { sendToBackground } from '@/lib/messaging';
import type { Settings } from '@/lib/types';
import type { VendorManifest } from '@/lib/local/registry';

interface Props {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}

type Probe = { state: 'idle' | 'testing' | 'ok' | 'fail'; detail?: string };

/** "Автономный режим": только локальные ресурсы, включённые в пакет расширения. */
export default function LocalSection({ settings, patch }: Props) {
  const { t } = useTranslation();
  const [vendor, setVendor] = useState<VendorManifest | null>(null);
  const [probe, setProbe] = useState<Probe>({ state: 'idle' });

  useEffect(() => {
    void getVendorManifest().then(setVendor);
  }, []);

  const packReady = Boolean((vendor?.tesseract || settings.useNativeHost) && vendor?.pairs.length);
  const isBundled = (pair: string) => Boolean(vendor?.pairs.includes(pair));
  /** Пока манифест не прочитан, чекбоксы не блокируем (статус неизвестен). */
  const isLangBundled = (id: string) => !vendor || Boolean(vendor.ocrLangs.includes(id));

  const clearCache = async () => {
    await browser.runtime.sendMessage({ type: 'LOCAL_CACHE_CLEAR', target: 'offscreen' });
  };

  const testNativeHost = async () => {
    setProbe({ state: 'testing' });
    const res = await sendToBackground<{ ok?: boolean; info?: unknown; error?: string }>({
      type: 'CHECK_NATIVE_HOST',
    });
    setProbe(
      res?.ok
        ? { state: 'ok', detail: JSON.stringify(res.info) }
        : { state: 'fail', detail: res?.error },
    );
  };

  return (
    <section className="card">
      <h2>{t('options.engineLocal')}</h2>

      <div className="field">
        <label>{t('options.ocrLangs')}</label>
        <div className="lang-checks">
          {listOcrLangs().map((l) => {
            const bundled = isLangBundled(l.id);
            return (
              <label key={l.id} className="checkbox">
                <input
                  type="checkbox"
                  disabled={!bundled}
                  checked={settings.ocrLangs.includes(l.id)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...settings.ocrLangs, l.id]
                      : settings.ocrLangs.filter((x) => x !== l.id);
                    patch({ ocrLangs: next.length ? next : ['eng'] });
                  }}
                />
                {l.label}{' '}
                <span className="hint">
                  ≈{l.approxMB} МБ{bundled ? '' : ` · ${t('options.ocrLangNotBundled')}`}
                </span>
              </label>
            );
          })}
        </div>
        <div className="hint">{t('options.ocrLangsHint')}</div>
      </div>

      <div className="field">
        <label htmlFor="ocrQuality">{t('options.ocrQuality')}</label>
        <select
          id="ocrQuality"
          value={settings.ocrQuality ?? 'balanced'}
          onChange={(e) => patch({ ocrQuality: e.target.value as Settings['ocrQuality'] })}
        >
          <option value="fast">{t('options.ocrQualityFast')}</option>
          <option value="balanced">{t('options.ocrQualityBalanced')}</option>
          <option value="best">{t('options.ocrQualityBest')}</option>
        </select>
        <div className="hint">{t('options.ocrQualityHint')}</div>
      </div>

      <div className="field">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.useNativeHost}
            onChange={(e) => patch({ useNativeHost: e.target.checked })}
          />
          {t('options.nativeHostEnable')}
        </label>
        <div className="hint">{t('options.nativeHostHint')}</div>
        <div className="row">
          <button onClick={() => void testNativeHost()} disabled={probe.state === 'testing'}>
            {t('options.nativeHostTest')}
          </button>
        </div>
        {probe.state === 'ok' && (
          <div className="status ok">
            ✓ {t('options.connectionOk')} — {probe.detail}
          </div>
        )}
        {probe.state === 'fail' && (
          <div className="status fail">
            ✕ {t('options.connectionFail')} — {probe.detail}
          </div>
        )}
      </div>

      <div className="field">
        <label>{t('options.mtModels')}</label>
        <div className="model-list">
          {listPairs().map((p) => {
            const bundled = isBundled(p.id);
            return (
              <div key={p.id} className="model-row">
                <span className="model-name">
                  {p.id} <span className="hint">≈{p.approxMB} МБ</span>
                </span>
                <span className={`status ${bundled ? 'ok' : 'fail'}`}>
                  {bundled ? t('options.modelBundled') : t('options.modelNotBundled')}
                </span>
              </div>
            );
          })}
        </div>
        <div className="hint">{t('options.mtHint')}</div>
      </div>

      {!packReady && <div className="status fail">⚠ {t('options.offlinePackMissing')}</div>}

      <div className="field">
        <label htmlFor="ocrMinConfidence">
          {t('options.ocrMinConfidence')}: {settings.ocrMinConfidence ?? 40}%
        </label>
        <input
          id="ocrMinConfidence"
          type="range"
          min={0}
          max={100}
          step={5}
          value={settings.ocrMinConfidence ?? 40}
          onChange={(e) => patch({ ocrMinConfidence: Number(e.target.value) || 0 })}
        />
        <div className="hint">{t('options.ocrMinConfidenceHint')}</div>
      </div>

      <div className="field">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.cloudOcr ?? false}
            onChange={(e) => patch({ cloudOcr: e.target.checked })}
          />
          {t('options.cloudOcr')}
        </label>
        <div className="hint">{t('options.cloudOcrHint')}</div>
      </div>

      {settings.cloudOcr && (
        <div className="field">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.cloudTranslate ?? false}
              onChange={(e) => patch({ cloudTranslate: e.target.checked })}
            />
            {t('options.cloudTranslate')}
          </label>
          <div className="hint">{t('options.cloudTranslateHint')}</div>
        </div>
      )}

      <div className="field">
        <label htmlFor="externalMt">{t('options.externalMt')}</label>
        <select
          id="externalMt"
          value={settings.externalMt ?? 'off'}
          onChange={(e) => patch({ externalMt: e.target.value as Settings['externalMt'] })}
        >
          <option value="off">{t('options.externalMtOff')}</option>
          <option value="google">{t('options.externalMtGoogle')}</option>
          <option value="yandex">{t('options.externalMtYandex')}</option>
        </select>
        <div className="hint">{t('options.externalMtHint')}</div>
      </div>

      {settings.externalMt !== 'off' && (
        <div className="field">
          <label htmlFor="externalMtPriority">{t('options.externalMtPriority')}</label>
          <select
            id="externalMtPriority"
            value={settings.externalMtPriority ?? 'prefer'}
            onChange={(e) =>
              patch({ externalMtPriority: e.target.value as Settings['externalMtPriority'] })
            }
          >
            <option value="prefer">{t('options.externalMtPrefer')}</option>
            <option value="fallback">{t('options.externalMtFallback')}</option>
          </select>
          <div className="hint">{t('options.externalMtPriorityHint')}</div>
        </div>
      )}

      <div className="row">
        <button onClick={() => void clearCache()}>{t('options.clearResultCache')}</button>
      </div>
      <div className="privacy">{t('options.vendorHint')}</div>
    </section>
  );
}
