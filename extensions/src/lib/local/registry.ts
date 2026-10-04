import registry from './registry.json';

export interface PairMeta {
  id: string;
  model: string;
  approxMB: number;
}

export interface OcrLangMeta {
  id: string;
  label: string;
  approxMB: number;
  /** true — пакет не качается по умолчанию (npm run vendor с TRANSLATE_VENDOR_EXTRA=1). */
  optional?: boolean;
}

export interface VendorManifest {
  version: number;
  baseUrl: string;
  pairs: string[];
  ocrLangs: string[];
  bundledOcrLangs?: string[];
  ocrModelRevision?: string;
  /** worker/core/traineddata Tesseract входят в комплект */
  tesseract?: boolean;
  createdAt: string;
}

export function listPairs(): PairMeta[] {
  return registry.pairs;
}

export function listOcrLangs(): OcrLangMeta[] {
  return registry.ocrLangs;
}

export function pairMeta(id: string): PairMeta | undefined {
  return registry.pairs.find((p) => p.id === id);
}

export function pairModel(id: string): string | undefined {
  return pairMeta(id)?.model;
}

/** Отобразить id пары ('en-ru') в { from: 'en', to: 'ru' }. */
export function pairLangs(id: string): { from: string; to: string } {
  const [from, to] = id.split('-');
  return { from, to };
}

/** Найти id пары для направления перевода, например ('en','ru') -> 'en-ru'. */
export function findPair(from: string, to: string): string | undefined {
  return registry.pairs.find((p) => p.id === `${from}-${to}`)?.id;
}
