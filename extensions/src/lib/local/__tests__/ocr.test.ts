import { describe, expect, it } from 'vitest';
import { pickBestOcr, scoreOcrResult, type OcrResult } from '../ocr';

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