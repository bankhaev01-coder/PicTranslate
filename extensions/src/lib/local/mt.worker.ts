/// <reference lib="webworker" />
/**
 * NMT-воркер: машинный перевод на Transformers.js (ONNX Runtime Web).
 * Живёт внутри offscreen-документа (reason: WORKERS).
 *
 * Vendor-режим обязателен: модели + ORT wasm грузятся с chrome-extension://,
 * воркер никогда не откатывается на удалённый хост моделей.
 */
import { env, pipeline } from '@huggingface/transformers';
import { normalizeMtInput } from './text';

type TranslateFn = (text: string) => Promise<string>;

let translateFn: TranslateFn | null = null;
let readyModel = '';
/** Сериализует init/translate/forget — иначе async onmessage гонялись бы между собой. */
let chain: Promise<void> = Promise.resolve();

interface WorkerIn {
  op: 'init' | 'translate' | 'forget';
  id?: number;
  pair?: string;
  model?: string;
  baseUrl?: string | null;
  text?: string;
}

async function doInit(msg: WorkerIn): Promise<void> {
  const pair = msg.pair!;
  const model = msg.model!;
  const baseUrl = msg.baseUrl || null;

  // Локальный движок намеренно строг: отсутствующий vendor-пак — это ошибка
  // установки, а не повод для неявной загрузки с CDN.
  if (!baseUrl) throw new Error('offline asset pack is missing');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useBrowserCache = false;
  env.useWasmCache = true;
  env.localModelPath = new URL('models/', baseUrl).href;

  // Мутируем существующий объект ONNX-окружения in place. Замена
  // env.backends.onnx оставила бы приватный ONNX_ENV рантайма нетронутым.
  const onnx = (env.backends as unknown as {
    onnx?: { wasm?: { wasmPaths?: unknown } };
  }).onnx;
  if (!onnx?.wasm) throw new Error('ONNX WASM backend is unavailable');
  onnx.wasm.wasmPaths = new URL('ort/', baseUrl).href;

  if (translateFn && readyModel === model) {
    postMessage({ op: 'ready', id: msg.id, pair });
    return;
  }

  translateFn = null;
  const pipe = (await pipeline('translation', model, {
    // Держим бандл CPU WASM детерминированным. WebGPU может требовать
    // отдельный JSEP-бинарь, который намеренно не входит в офлайн-пак.
    device: 'wasm',
    dtype: 'q8',
    progress_callback: (p: Record<string, unknown>) => {
      if (p?.status === 'progress') {
        postMessage({
          op: 'progress',
          pair,
          file: String(p.file ?? ''),
          loaded: Number(p.loaded ?? 0),
          total: Number(p.total ?? 0),
        });
      }
    },
  } as never)) as unknown as (text: string, opts: Record<string, unknown>) => Promise<
    Array<{ translation_text?: string }>
  >;

  translateFn = async (text: string) => {
    // Гарантия «одна строка» на входе модели: перенос строки — не смысловая
    // граница OCR-текста; осмысленная склейка фразы — в joinOcrLines.
    const out = await pipe(normalizeMtInput(text), { max_new_tokens: 480, truncation: true });
    return out?.[0]?.translation_text ?? '';
  };
  readyModel = model;
  postMessage({ op: 'ready', id: msg.id, pair });
}

async function doForget(msg: WorkerIn): Promise<void> {
  const model = msg.model ?? '';
  try {
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    await Promise.all(
      keys.filter((r) => r.url.includes(model)).map((r) => cache.delete(r)),
    );
  } catch {
    /* по возможности */
  }
  if (readyModel === model) {
    translateFn = null;
    readyModel = '';
  }
  // id обязателен: MtClient сопоставляет ответы с ожидающими промисами по id —
  // без него forget() никогда не завершался.
  postMessage({ op: 'forgot', id: msg.id, model });
}

async function dispatch(msg: WorkerIn): Promise<void> {
  try {
    if (msg.op === 'init') {
      await doInit(msg);
    } else if (msg.op === 'translate') {
      if (!translateFn) {
        postMessage({ op: 'error', id: msg.id, error: 'MT_NOT_INITIALIZED' });
        return;
      }
      const text = await translateFn(msg.text ?? '');
      postMessage({ op: 'translated', id: msg.id, text });
    } else if (msg.op === 'forget') {
      await doForget(msg);
    }
  } catch (err) {
    postMessage({ op: 'error', id: msg.id, error: String(err) });
  }
}

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  chain = chain.then(() => dispatch(e.data));
};
