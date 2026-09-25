import { browser } from 'wxt/browser';

export const NATIVE_HOST_NAME = 'com.manga.translate.host';

export interface NativeHostRequest {
  action: 'ping' | 'ocr';
  image_base64?: string;
  langs?: string[];
}

export interface NativeHostResponse {
  ok: boolean;
  version?: string;
  tesseract_available?: boolean;
  source_text?: string;
  boxes?: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    text?: string;
  }>;
  error?: string;
}

/**
 * Отправляет сообщение в Chrome Native Messaging хост.
 * Никогда не бросает исключение: сбои транспорта возвращаются как `{ ok: false, error }`.
 */
export async function sendNativeMessage(msg: NativeHostRequest): Promise<NativeHostResponse> {
  const runtime = browser.runtime as typeof browser.runtime & {
    sendNativeMessage?: (application: string, message: unknown) => Promise<NativeHostResponse>;
  };

  if (typeof runtime.sendNativeMessage !== 'function') {
    return { ok: false, error: 'Native messaging is not available in this context' };
  }

  try {
    const response = await runtime.sendNativeMessage(NATIVE_HOST_NAME, msg);
    return response ?? { ok: false, error: 'Empty response from the native host' };
  } catch (e: unknown) {
    return { ok: false, error: describeNativeError(e) };
  }
}

/** Chrome сообщает об отсутствующем хосте как об общем «not found» — сделаем сообщение полезным. */
function describeNativeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/not found|specified native messaging host|Forbidden|Access to the specified/i.test(raw)) {
    return (
      `${raw} — the native host is not installed. Run native_host/install_host.bat <EXTENSION_ID> ` +
      'and make sure tesseract is on PATH.'
    );
  }
  return raw;
}

/** Проверить, установлен ли native host и отвечает ли он. */
export async function checkNativeHost(): Promise<{ ok: boolean; info?: unknown; error?: string }> {
  try {
    const res = await sendNativeMessage({ action: 'ping' });
    if (res.ok) {
      return { ok: true, info: res };
    }
    return { ok: false, error: res.error || 'Native host returned error' };
  } catch (e: unknown) {
    return { ok: false, error: String(e) };
  }
}
