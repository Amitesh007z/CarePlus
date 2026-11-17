import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest, pingApi } from './api';

function mockFetch(impl: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

afterEach(() => vi.unstubAllGlobals());

describe('apiRequest', () => {
  it('unwraps data from the success envelope and sends credentials', async () => {
    mockFetch(() => json({ success: true, data: { message: 'pong', time: 't' }, requestId: 'r1' }));
    await expect(pingApi()).resolves.toEqual({ message: 'pong', time: 't' });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/v1\/ping$/);
    expect(init?.credentials).toBe('include');
  });

  it('throws ApiError carrying code, details and requestId from the error envelope', async () => {
    mockFetch(() =>
      json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'bad', details: [{ path: 'a', message: 'x' }] }, requestId: 'r2' }, 422),
    );
    const err = await apiRequest('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'VALIDATION_ERROR', requestId: 'r2', details: [{ path: 'a', message: 'x' }] });
  });

  it('maps network failures to a friendly NETWORK_ERROR', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(apiRequest('/x')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });

  it('handles non-JSON error responses without leaking them', async () => {
    mockFetch(() => Promise.resolve(new Response('<html>502 stack trace</html>', { status: 502 })));
    const err = (await apiRequest('/x').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('UNEXPECTED_RESPONSE');
    expect(err.message).not.toContain('stack trace');
  });

  it('serializes JSON bodies with a content type', async () => {
    mockFetch(() => json({ success: true, data: null, requestId: 'r' }));
    await apiRequest('/x', { method: 'POST', body: { a: 1 } });
    const init = vi.mocked(fetch).mock.calls[0]![1]!;
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });
});
