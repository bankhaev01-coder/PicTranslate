import type { VendorManifest } from './registry';
import { pairModel } from './registry';

/** Первая загрузка модели (чтение ONNX + компиляция wasm) может идти долго. */
const INIT_TIMEOUT_MS = 180_000;
/** Один фрагмент текста: дольше — признак повисшего воркера. */
const TRANSLATE_TIMEOUT_MS = 90_000;
const FORGET_TIMEOUT_MS = 30_000;

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Promise-прокси из offscreen-документа к mt.worker.ts.
 *
 * У каждого запроса есть таймаут: внутри воркера запросы сериализованы, и
 * без таймаута один зависший вызов навсегда блокировал бы весь локальный
 * конвейер (pipelineChain в offscreen). По таймауту воркер пересоздаётся.
 */
export class MtClient {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private readyPair: string | null = null;

  constructor() {}

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./mt.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      if (worker !== this.worker) return; // ответ уже остановленного воркера
      const msg = e.data as Record<string, unknown> & { op: string };
      if (msg.op === 'progress') return;
      if (msg.op === 'ready') {
        this.readyPair = String(msg.pair ?? '');
      }
      if (msg.op === 'translated' || msg.op === 'ready' || msg.op === 'forgot' || msg.op === 'error') {
        const id = msg.id as number | undefined;
        const p = id !== undefined ? this.pending.get(id) : undefined;
        if (id !== undefined && p) {
          this.pending.delete(id);
          clearTimeout(p.timer);
          if (msg.op === 'error') p.reject(new Error(String(msg.error ?? 'mt error')));
          else p.resolve(msg.text ?? true);
        }
      }
    };
    worker.onerror = (e) => {
      // Жёсткие сбои (битый wasm, CSP) — всем ожидающим запросам.
      if (worker !== this.worker) return;
      this.resetWorker(new Error(`mt worker: ${e.message}`));
    };
    worker.onmessageerror = () => {
      if (worker !== this.worker) return;
      this.resetWorker(new Error('mt worker: message could not be deserialized'));
    };
    this.worker = worker;
    return worker;
  }

  /** Остановить воркер и отклонить все ожидающие запросы. */
  private resetWorker(reason: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.readyPair = null;
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
  }

  private request<T>(msg: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const w = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`mt worker timeout: ${String(msg.op)} > ${timeoutMs} ms`));
        // Воркер, скорее всего, завис: следующие запросы застряли бы за этим.
        this.resetWorker(new Error('mt worker restarted after a timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      w.postMessage({ ...msg, id });
    });
  }

  /** Инициализировать встроенную локальную модель. Резолвится, когда модель готова. */
  ensurePair(pair: string, vendor: VendorManifest | null): Promise<unknown> {
    if (this.readyPair === pair) return Promise.resolve(true);
    const model = pairModel(pair);
    if (!model) return Promise.reject(new Error(`unknown pair: ${pair}`));
    return this.request({ op: 'init', pair, model, baseUrl: vendor?.baseUrl ?? null }, INIT_TIMEOUT_MS);
  }

  /** Перевести один фрагмент (модель должна быть готова — сначала ensurePair). */
  translate(pair: string, text: string): Promise<string> {
    const model = pairModel(pair);
    if (!model) return Promise.reject(new Error(`unknown pair: ${pair}`));
    // В воркере загружена одна модель: перевод «не той» парой дал бы мусор.
    if (this.readyPair !== pair) return Promise.reject(new Error('MT_NOT_INITIALIZED'));
    return this.request<string>({ op: 'translate', pair, text }, TRANSLATE_TIMEOUT_MS);
  }

  /** Выгрузить закешированные файлы пары (и выгрузить её из памяти). */
  forget(pair: string): Promise<unknown> {
    const model = pairModel(pair);
    if (!model) return Promise.resolve(true);
    // Воркер сбрасывает загруженную модель, поэтому снимаем и признак готовности:
    // иначе следующий ensurePair вернёт «готово» и translate упадёт с
    // MT_NOT_INITIALIZED до следующего явного init.
    return this.request({ op: 'forget', model }, FORGET_TIMEOUT_MS).then((v) => {
      if (this.readyPair === pair) this.readyPair = null;
      return v;
    });
  }

  isReady(pair: string): boolean {
    return this.readyPair === pair;
  }
}
