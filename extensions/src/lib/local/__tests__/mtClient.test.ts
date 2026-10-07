import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MtClient } from '../mtClient';
import type { VendorManifest } from '../registry';

/**
 * Подставной Worker: запоминает сообщения и позволяет «ответить» от имени
 * воркера. В vitest нет Web Worker API, а поведение клиента (сброс готовности
 * пары, разбор ошибок) проверяется именно на протоколе обмена сообщениями.
 */
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  terminated = false;

  postMessage(msg: Record<string, unknown>): void {
    this.sent.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: msg } as MessageEvent);
  }

  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

let worker: FakeWorker | null = null;

beforeEach(() => {
  worker = null;
  vi.stubGlobal(
    'Worker',
    class extends FakeWorker {
      constructor() {
        super();
        worker = this;
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const vendor: VendorManifest = {
  version: 1,
  baseUrl: 'chrome-extension://test/vendor/',
  pairs: ['en-ru'],
  ocrLangs: ['eng'],
  tesseract: true,
  createdAt: '2026-09-29',
};

describe('MtClient', () => {
  it('remembers a pair as ready only after the worker confirms init', async () => {
    const client = new MtClient();
    const init = client.ensurePair('en-ru', vendor);
    expect(worker?.sent[0]).toMatchObject({ op: 'init', pair: 'en-ru', baseUrl: vendor.baseUrl });
    expect(client.isReady('en-ru')).toBe(false); // до ответа воркера пары ещё нет

    worker?.reply({ op: 'ready', id: worker.sent[0].id, pair: 'en-ru' });
    await init;
    expect(client.isReady('en-ru')).toBe(true);
  });

  it('clears readiness after forget, so the next ensurePair re-initializes', async () => {
    const client = new MtClient();
    const init = client.ensurePair('en-ru', vendor);
    worker?.reply({ op: 'ready', id: worker.sent[0].id, pair: 'en-ru' });
    await init;

    const forgotten = client.forget('en-ru');
    expect(worker?.sent[1]).toMatchObject({ op: 'forget', model: 'Xenova/opus-mt-en-ru' });
    worker?.reply({ op: 'forgot', id: worker.sent[1].id });
    await forgotten;

    // Воркер модель выгрузил: клиент обязан снова прислать init, а не сказать «готово».
    expect(client.isReady('en-ru')).toBe(false);
    const again = client.ensurePair('en-ru', vendor);
    expect(worker?.sent[2]).toMatchObject({ op: 'init', pair: 'en-ru' });
    worker?.reply({ op: 'ready', id: worker.sent[2].id, pair: 'en-ru' });
    await again;
    expect(client.isReady('en-ru')).toBe(true);
  });

  it('rejects translation before the pair is initialized, without asking the worker', async () => {
    const client = new MtClient();
    await expect(client.translate('en-ru', 'hello')).rejects.toThrow('MT_NOT_INITIALIZED');
    expect(worker?.sent ?? []).toHaveLength(0);
  });

  it('rejects translation with the worker error text (MT_NOT_INITIALIZED)', async () => {
    const client = new MtClient();
    const init = client.ensurePair('en-ru', vendor);
    worker?.reply({ op: 'ready', id: worker.sent[0].id, pair: 'en-ru' });
    await init;

    const pending = client.translate('en-ru', 'hello');
    expect(worker?.sent[1]).toMatchObject({ op: 'translate', pair: 'en-ru', text: 'hello' });
    worker?.reply({ op: 'error', id: worker.sent[1].id, error: 'MT_NOT_INITIALIZED' });
    await expect(pending).rejects.toThrow('MT_NOT_INITIALIZED');
  });

  it('rejects every pending request when the worker itself crashes', async () => {
    const client = new MtClient();
    const init = client.ensurePair('en-ru', vendor);
    worker?.reply({ op: 'ready', id: worker.sent[0].id, pair: 'en-ru' });
    await init;

    const first = client.translate('en-ru', 'one');
    const second = client.translate('en-ru', 'two');
    worker?.crash('wasm aborted');
    await expect(first).rejects.toThrow('mt worker: wasm aborted');
    await expect(second).rejects.toThrow('mt worker: wasm aborted');
    expect(worker?.terminated).toBe(true);
    // После сбоя воркер пересоздаётся: готовность пары тоже сброшена.
    expect(client.isReady('en-ru')).toBe(false);
  });
});
