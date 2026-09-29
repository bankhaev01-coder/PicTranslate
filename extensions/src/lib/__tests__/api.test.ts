import { describe, expect, it } from 'vitest';
import { httpErrorDetail } from '../api';

describe('httpErrorDetail', () => {
  it('keeps a plain FastAPI string detail', () => {
    expect(httpErrorDetail({ detail: 'Unsupported model' }, 'HTTP 400')).toBe('Unsupported model');
    expect(httpErrorDetail({ detail: '  spaced  ' }, 'HTTP 400')).toBe('spaced');
  });

  it('serializes the FastAPI 422 validation array instead of [object Object]', () => {
    const body = {
      detail: [{ loc: ['body', 'file'], msg: 'field required', type: 'value_error.missing' }],
    };
    const detail = httpErrorDetail(body, 'HTTP 422');
    expect(detail).toContain('field required');
    expect(detail).not.toContain('[object Object]');
  });

  it('falls back to the error field and to the HTTP status', () => {
    expect(httpErrorDetail({ error: 'boom' }, 'HTTP 500')).toBe('boom');
    expect(httpErrorDetail({ detail: {} }, 'HTTP 500')).toBe('HTTP 500');
    expect(httpErrorDetail({ detail: [] }, 'HTTP 500')).toBe('HTTP 500');
    expect(httpErrorDetail(null, 'HTTP 500')).toBe('HTTP 500');
    expect(httpErrorDetail('not-an-object', 'HTTP 500')).toBe('HTTP 500');
  });

  it('stringifies scalar details (число/булево в теле ответа)', () => {
    expect(httpErrorDetail({ detail: 42 }, 'HTTP 500')).toBe('42');
    expect(httpErrorDetail({ detail: false }, 'HTTP 500')).toBe('false');
  });

  it('survives a circular body without throwing', () => {
    const body: Record<string, unknown> = {};
    body.detail = body;
    expect(httpErrorDetail(body, 'HTTP 500')).toBe('HTTP 500');
  });
});
