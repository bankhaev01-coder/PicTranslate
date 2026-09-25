import type { VendorManifest } from './registry';
import { pairModel } from './registry';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Promise-прокси из offscreen-документа к mt.worker.ts. */
export class MtClient {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private readyPair: string | null = null;

  constructor() {}

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./mt.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as Record<string, unknown> & { op: string };
      if (msg.op === 'progress') return;
      if (msg.op === 'ready') {
        this.readyPair = String(msg.pair ?? '');
      }
      if (msg.op === 'translated' || msg.op === 'ready' || msg.op === 'forgot' || msg.op === 'error') {
        const id = msg.id as number | undefined;
        if (id !== undefined && this.pending.has(id)) {
          const p = this.pending.get(id)!;
          this.pending.delete(id);
          if (msg.op === 'error') p.reject(new Error(String(msg.error ?? 'mt error')));
          else p.resolve(msg.text ?? true);
        }
      }
    };
    this.worker.onerror = (e) => {
      // Сообщить о жёстких сбоях (битый wasm, CSP) всем ожидающим запросам.
      for (const [, p] of this.pending) p.reject(new Error(`mt worker: ${e.message}`));
      this.pending.clear();
      this.worker = null;
      this.readyPair = null;
    };
    return this.worker;
  }

  /** Инициализировать встроенную локальную модель. Резолвится, когда модель готова. */
  ensurePair(pair: string, vendor: VendorManifest | null): Promise<unknown> {
    if (this.readyPair === pair) return Promise.resolve(true);
    const model = pairModel(pair);
    if (!model) return Promise.reject(new Error(`unknown pair: ${pair}`));
    const w = this.ensureWorker();
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    w.postMessage({ op: 'init', id, pair, model, baseUrl: vendor?.baseUrl ?? null });
    return promise;
  }

  /** Перевести один фрагмент (модель должна быть готова — сначала ensurePair). */
  translate(pair: string, text: string): Promise<string> {
    const model = pairModel(pair);
    if (!model) return Promise.reject(new Error(`unknown pair: ${pair}`));
    const w = this.ensureWorker();
    const id = this.nextId++;
    const promise = new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    w.postMessage({ op: 'translate', id, pair, text });
    return promise;
  }

  /** Выгрузить закешированные файлы пары (и выгрузить её из памяти). */
  forget(pair: string): Promise<unknown> {
    const model = pairModel(pair);
    if (!model) return Promise.resolve(true);
    const w = this.ensureWorker();
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    w.postMessage({ op: 'forget', id, model });
    return promise;
  }

  isReady(pair: string): boolean {
    return this.readyPair === pair;
  }
}
