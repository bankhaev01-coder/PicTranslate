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
          {listOcrLangs().map((l) => (
            <label key={l.id} className="checkbox">
              <input
                type="checkbox"
                checked={settings.ocrLangs.includes(l.id)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...settings.ocrLangs, l.id]
                    : settings.ocrLangs.filter((x) => x !== l.id);
                  patch({ ocrLangs: next.length ? next : ['eng'] });
                }}
              />
              {l.label} <span className="hint">≈{l.approxMB} МБ</span>
            </label>
          ))}
        </div>
        <div className="hint">{t('options.ocrLangsHint')}</div>
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

      <div className="row">
        <button onClick={() => void clearCache()}>{t('options.clearResultCache')}</button>
      </div>
      <div className="privacy">{t('options.vendorHint')}</div>
    </section>
  );
}
