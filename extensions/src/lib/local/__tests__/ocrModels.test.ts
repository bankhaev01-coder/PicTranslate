import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadOcrModel, listDownloadedOcrModels, removeOcrModel, validateTraineddata, resolveOcrLanguages } from '../ocrModels';
const entries = new Map<string, Response>();
const cache = {
  keys: async () => [...entries.keys()].map(url => new Request(url)),
  match: async (req: Request) => entries.get(req.url)?.clone(),
  put: async (req: Request, res: Response) => { entries.set(req.url, res.clone()); },
  delete: async (req: Request) => entries.delete(req.url),
};
const trained = () => { const data = new Uint8Array(64); const view = new DataView(data.buffer); view.setInt32(0, 1, true); view.setBigInt64(4, 12n, true); return data; };
const gzip = async (data: Uint8Array) => new Response(new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
beforeEach(() => { entries.clear(); vi.restoreAllMocks(); vi.stubGlobal('caches', { open: async () => cache }); });
describe('user-installed OCR models', () => {
  it('lists installed models without network activity', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    expect(await listDownloadedOcrModels()).toEqual([]); expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects identifiers outside the catalog before fetching', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(downloadOcrModel('../../evil')).rejects.toThrow('Unknown OCR language');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('stores a validated download and removes it independently of result cache', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(await gzip(trained())));
    await downloadOcrModel('jpn');
    expect(fetch).toHaveBeenCalledWith('https://' + 'tessdata.projectnaptha.com/4.0.0_best/jpn.traineddata.gz', expect.any(Object));
    expect((await listDownloadedOcrModels()).map(x => x.id)).toEqual(['jpn']);
    await removeOcrModel('jpn'); expect(await listDownloadedOcrModels()).toEqual([]);
  });
  it('does not mark HTTP failures or invalid files as installed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 429 })).mockResolvedValueOnce(new Response('<html>blocked</html>'));
    await expect(downloadOcrModel('jpn')).rejects.toThrow('HTTP 429');
    await expect(downloadOcrModel('jpn')).rejects.toThrow();
    expect(await listDownloadedOcrModels()).toEqual([]);
  });
  it('keeps the old valid model if replacement fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(await gzip(trained()))).mockResolvedValueOnce(new Response('bad'));
    await downloadOcrModel('jpn'); await expect(downloadOcrModel('jpn')).rejects.toThrow();
    expect(await listDownloadedOcrModels()).toHaveLength(1);
  });
  it('validates the traineddata header and offsets', () => {
    expect(() => validateTraineddata(trained())).not.toThrow();
    expect(() => validateTraineddata(new Uint8Array(64))).toThrow();
  });
});
describe('explicit source language safety', () => {
  it('does not silently use English when Japanese is missing', () => {
    expect(() => resolveOcrLanguages(['eng'], ['eng'], 'ja')).toThrow();
    expect(() => resolveOcrLanguages(['eng', 'jpn'], ['eng'], 'auto')).toThrow();
  });
  it('narrows Japanese recognition to selected installed Japanese models', () => {
    expect(resolveOcrLanguages(['eng', 'jpn', 'jpn_vert'], ['eng', 'jpn', 'jpn_vert'], 'ja')).toEqual(['jpn', 'jpn_vert']);
    expect(resolveOcrLanguages(['eng'], ['eng'], 'auto')).toEqual(['eng']);
  });
});
