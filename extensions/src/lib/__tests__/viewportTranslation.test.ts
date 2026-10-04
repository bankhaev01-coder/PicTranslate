import { describe, expect, it, vi } from 'vitest';
import { snapshotBoxesToDocument, translateViewport, type ViewportFrame } from '../viewportTranslation';
import type { TranslateResult } from '../types';
const frame: ViewportFrame = { scrollX: 10, scrollY: 200, width: 1000, height: 600, pixelRatio: 2 };
const result: TranslateResult = { source_text: 'HELLO', translation: 'Привет', model: 'test', latency_ms: 1,
  boxes: [{ x: 100, y: 200, width: 200, height: 100, translation: 'Привет' }] };
const deps = () => ({ frame: vi.fn(() => frame), capture: vi.fn().mockResolvedValue({ dataUrl: 'data:test' }),
  size: vi.fn().mockResolvedValue({ width: 2000, height: 1200 }),
  translate: vi.fn().mockResolvedValue(result), render: vi.fn(), isCurrent: vi.fn(() => true) });

describe('snapshotBoxesToDocument', () => {
  it('maps retina screenshot pixels into document coordinates independently of later scrolling', () => {
    expect(snapshotBoxesToDocument(result.boxes!, frame, 2000, 1200)).toEqual([
      { x: 60, y: 300, width: 100, height: 50, translation: 'Привет' },
    ]);
  });
  it('clips image-edge boxes, rejects offscreen and malformed boxes', () => {
    const boxes = [{ x: -10, y: -5, width: 30, height: 20, translation: 'edge' },
      { x: 2100, y: 0, width: 10, height: 10, translation: 'outside' },
      { x: NaN, y: 0, width: 10, height: 10, translation: 'bad' },
      { x: 0, y: 0, width: 0, height: 10, translation: 'zero' }];
    expect(snapshotBoxesToDocument(boxes, frame, 2000, 1200)).toEqual([
      { x: 10, y: 200, width: 10, height: 7.5, translation: 'edge' },
    ]);
    expect(snapshotBoxesToDocument(boxes, frame, 0, 1200)).toEqual([]);
  });
});

describe('translateViewport', () => {
  it('captures, translates and renders the screenshot on the original document frame', async () => {
    const d = deps();
    expect(await translateViewport(d)).toBe(result);
    expect(d.translate).toHaveBeenCalledExactlyOnceWith('data:test');
    expect(d.render).toHaveBeenCalledExactlyOnceWith(frame, { width: 2000, height: 1200 }, result);
  });
  it('rejects scrolling during capture instead of placing text on the wrong page position', async () => {
    const d = deps(); d.frame.mockReturnValueOnce(frame).mockReturnValue({ ...frame, scrollY: 230 });
    expect((await translateViewport(d)).error).toContain('moved during capture');
    expect(d.translate).not.toHaveBeenCalled(); expect(d.render).not.toHaveBeenCalled();
  });
  it('allows scrolling after capture and keeps the old document anchor', async () => {
    const d = deps(); d.translate.mockImplementation(async () => {
      d.frame.mockReturnValue({ ...frame, scrollY: 500 }); return result;
    });
    expect(await translateViewport(d)).toBe(result);
    expect(d.render).toHaveBeenCalledWith(frame, { width: 2000, height: 1200 }, result);
  });
  it('drops a superseded request before model execution', async () => {
    const d = deps(); d.isCurrent.mockReturnValue(false);
    expect((await translateViewport(d)).error).toContain('superseded');
    expect(d.translate).not.toHaveBeenCalled(); expect(d.render).not.toHaveBeenCalled();
  });
  it('drops a superseded result after the model completes', async () => {
    const d = deps(); d.isCurrent.mockReturnValueOnce(true).mockReturnValue(false);
    expect((await translateViewport(d)).error).toContain('superseded');
    expect(d.translate).toHaveBeenCalledOnce(); expect(d.render).not.toHaveBeenCalled();
  });
  it('does not render after zoom or resize during translation', async () => {
    const d = deps(); d.translate.mockImplementation(async () => {
      d.frame.mockReturnValue({ ...frame, pixelRatio: 1.5 }); return result;
    });
    expect((await translateViewport(d)).error).toContain('resized or zoomed');
    expect(d.render).not.toHaveBeenCalled();
  });
  it('returns capture errors without invoking a translator', async () => {
    const d = deps(); d.capture.mockResolvedValue({ error: 'capture denied' });
    expect((await translateViewport(d)).error).toBe('capture denied'); expect(d.translate).not.toHaveBeenCalled();
  });
  it('does not render a provider error or a failed image decode', async () => {
    const d = deps(); d.translate.mockResolvedValue({ ...result, error: '429' });
    expect((await translateViewport(d)).error).toBe('429'); expect(d.render).not.toHaveBeenCalled();
    d.size.mockRejectedValue(new Error('decode failed'));
    expect((await translateViewport(d)).error).toContain('decode failed');
  });
  it('rejects empty dimensions', async () => {
    const d = deps(); d.size.mockResolvedValue({ width: 0, height: 100 });
    expect((await translateViewport(d)).error).toContain('invalid dimensions'); expect(d.translate).not.toHaveBeenCalled();
  });
});
