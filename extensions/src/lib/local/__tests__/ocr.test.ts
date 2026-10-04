import { describe, expect, it } from 'vitest';
import { assembleOcrResult, pickBestOcr, scoreOcrResult, type OcrResult } from '../ocr';

const res = (text: string, confidence: number): OcrResult => ({
  text,
  boxes: [],
  confidence,
});

describe('scoreOcrResult', () => {
  it('scores an empty text as 0 regardless of confidence', () => {
    expect(scoreOcrResult({ text: '   ', confidence: 99 })).toBe(0);
    expect(scoreOcrResult({ text: '', confidence: 99 })).toBe(0);
  });

  it('favors longer text at equal confidence', () => {
    const short = scoreOcrResult(res('Hi', 80));
    const long = scoreOcrResult(res('Hello world, this is a real sentence', 80));
    expect(long).toBeGreaterThan(short);
  });

  it('favors higher confidence at equal length', () => {
    const low = scoreOcrResult(res('Hello', 50));
    const high = scoreOcrResult(res('Hello', 90));
    expect(high).toBeGreaterThan(low);
  });
});

describe('pickBestOcr', () => {
  it('returns an empty result for no candidates', () => {
    expect(pickBestOcr([])).toEqual({ text: '', boxes: [], confidence: 0 });
  });

  it('picks the candidate with the best confidence×length score', () => {
    const noise = res('a', 99); // высокая уверенность, но почти нет текста
    const garbage = res('', 100); // вообще без текста
    const real = res('Привет, мир — это тест', 76);
    expect(pickBestOcr([noise, garbage, real])).toBe(real);
  });

  it('returns the single candidate when it is the only one', () => {
    const only = res('Hello', 60);
    expect(pickBestOcr([only])).toBe(only);
  });
});

describe('assembleOcrResult', () => {
  const bbox = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

  const data = {
    text: 'Hello\nthere\n\nSecond block',
    confidence: 88,
    blocks: [
      {
        text: 'Hello\nthere',
        confidence: 88,
        bbox: bbox(0, 0, 100, 50),
        paragraphs: [{ text: 'Hello\nthere', confidence: 88, bbox: bbox(0, 0, 100, 50) }],
      },
      { text: 'Second block', confidence: 70, bbox: bbox(0, 60, 90, 80) },
    ],
  };

  it('glues a multi-line paragraph into one string (box and overall text)', () => {
    const out = assembleOcrResult(data, 40, false);
    expect(out.confidence).toBe(88);
    expect(out.boxes[0].text).toBe('Hello there');
    // Полный скан: каждый блок — своя строка, внутри блока текст склеен.
    expect(out.text).toBe('Hello there\nSecond block');
  });

  it('merges all blocks into a single line in region mode', () => {
    const out = assembleOcrResult(data, 40, true);
    expect(out.text).toBe('Hello there Second block');
  });

  it('falls back to the block bbox when paragraphs are missing', () => {
    const out = assembleOcrResult(data, 40, false);
    expect(out.boxes).toHaveLength(2);
    expect(out.boxes[1]).toEqual({
      x: 0,
      y: 60,
      width: 90,
      height: 20,
      text: 'Second block',
    });
  });

  it('drops blocks and paragraphs below minConfidence', () => {
    const out = assembleOcrResult(data, 80, false);
    expect(out.boxes).toHaveLength(1);
    expect(out.text).toBe('Hello there');
  });

  it('handles empty data safely', () => {
    expect(assembleOcrResult(undefined, 40, false)).toEqual({
      text: '',
      boxes: [],
      confidence: 0,
    });
    expect(assembleOcrResult({}, 40, true)).toEqual({ text: '', boxes: [], confidence: 0 });
  });
});

describe('rejected OCR blocks', () => {
  it('does not bring rejected full-page noise back through raw text', () => {
    expect(assembleOcrResult({ text: 'GD) fake', confidence: 10,
      blocks: [{ text: 'GD) fake', confidence: 10 }] }, 40, false).text).toBe('');
  });
  it('still preserves raw text when structured blocks are unavailable', () => {
    expect(assembleOcrResult({ text: 'HELLO\nTHERE', confidence: 90 }, 40, false).text).toBe('HELLO THERE');
  });
});
