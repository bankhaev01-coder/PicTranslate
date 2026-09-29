import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { browser } from 'wxt/browser';
import { checkHealth } from '@/lib/api';
import { hasDirectAiKey } from '@/lib/ai/engine';
import { sendToBackground } from '@/lib/messaging';
import { getSettings } from '@/lib/storage';
import type { ScanImagesResponse, Settings, TranslateResult } from '@/lib/types';

type Health = 'unknown' | 'ok' | 'fail';

/** Суффикс локали `options.engine*` по id движка. */
const ENGINE_LABEL: Record<Settings['engine'], string> = {
  ai: 'Ai',
  local: 'Local',
  backend: 'Backend',
};

export default function App() {
  const { t } = useTranslation();
  const [health, setHealth] = useState<Health>('unknown');
  const [engine, setEngine] = useState<Settings['engine']>('ai');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [shot, setShot] = useState<TranslateResult | null>(null);

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      setEngine(s.engine);
      if (s.engine === 'ai') {
        // Безсерверный режим: достаточно ключа, хранящегося локально.
        setHealth(hasDirectAiKey(s) ? 'ok' : 'fail');
        return;
      }
      if (s.engine === 'local') {
        // Автономный режим: пинговать нечего — модели внутри расширения.
        setHealth('ok');
        return;
      }
      const h = await checkHealth(s.backendUrl);
      setHealth(h.ok ? 'ok' : 'fail');
    })();
  }, []);

  const withActiveTab = useCallback(
    async (fn: (tabId: number) => Promise<void>) => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id == null) {
        setNote(t('popup.notSupported'));
        return;
      }
      try {
        await fn(tab.id);
      } catch (e) {
        setNote(String(e));
      }
    },
    [t],
  );

  const scanPage = () =>
    withActiveTab(async (tabId) => {
      setNote('');
      const res = await sendToBackground<ScanImagesResponse>({
        type: 'SCAN_TAB',
        tabId,
      });
      if (!res?.ok) {
        setNote(res?.error || t('popup.notSupported'));
        return;
      }
      setNote(t('popup.imagesFound', { count: res.count ?? 0 }));
      window.close();
    });

  const screenshot = async () => {
    setBusy(true);
    setShot(null);
    setNote(t('popup.screenshotHint'));
    try {
      // tabId нужен background, чтобы спрятать оверлей вкладки перед скриншотом
      // (панель/контуры не должны попадать в OCR/vision-модель).
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const res = await sendToBackground<TranslateResult>({
        type: 'CAPTURE_AND_TRANSLATE',
        ...(tab?.id != null ? { tabId: tab.id } : {}),
      });
      setShot(res);
    } finally {
      setBusy(false);
    }
  };

  const openOptions = async () => {
    setNote('');
    try {
      await browser.runtime.openOptionsPage();
      window.close();
    } catch (e) {
      // openOptionsPage может быть недоступен — открываем настройки вкладкой.
      try {
        await browser.tabs.create({ url: new URL('options.html', window.location.origin).toString() });
        window.close();
      } catch {
        setNote(`${t('common.error')}: ${String(e)}`);
      }
    }
  };

  const clearOverlay = () =>
    withActiveTab(async (tabId) => {
      setNote('');
      const res = await sendToBackground<{ ok?: boolean; error?: string }>({
        type: 'CLEAR_OVERLAY',
        tabId,
      });
      if (!res?.ok) {
        setNote(res?.error || t('popup.notSupported'));
        return;
      }
      setNote(t('popup.overlayCleared'));
      window.close();
    });

  return (
    <div className="popup">
      <h1>
        <span className={`dot ${health}`} />
        {t('common.appName')}
        <span className="engine-tag">{t(`options.engine${ENGINE_LABEL[engine]}`)}</span>
      </h1>

      <button className="primary" onClick={scanPage}>
        {t('popup.scanPage')}
      </button>
      <button onClick={screenshot} disabled={busy}>
        {busy ? t('common.loading') : t('popup.screenshot')}
      </button>
      <button onClick={clearOverlay}>{t('popup.clearOverlay')}</button>
      <button onClick={() => void openOptions()}>{t('popup.openOptions')}</button>

      <div className="note">{note}</div>

      {shot && (
        <div className="result">
          {shot.error ? (
            <div className="err">⚠ {shot.error}</div>
          ) : (
            <>
              {shot.source_text && <div className="src">{shot.source_text}</div>}
              <div>{shot.translation || '—'}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
