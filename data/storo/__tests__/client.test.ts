import { afterEach, describe, expect, it, vi } from 'vitest';
import { API, apiError, reply, setup } from './helpers';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('apiRequest', () => {
  it('sends the device token, JSON body and idempotency key, and parses a success', async () => {
    const env = await setup({ handler: () => reply(201, { ok: 1 }, { 'X-Request-Id': 'r1' }) });
    const r = await env.client.apiRequest(API, '/sync/push', { body: { a: 1 }, token: 'tok', idempotencyKey: 'k1' });
    expect(r).toMatchObject({ ok: true, status: 201, data: { ok: 1 } });
    const c = env.calls[0];
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${API}/sync/push`);
    expect(c.headers.Authorization).toBe('Device tok');
    expect(c.headers['Idempotency-Key']).toBe('k1');
    expect(c.headers['Content-Type']).toBe('application/json');
    expect(c.body).toBe('{"a":1}');
  });

  it('sends a string body byte for byte', async () => {
    const env = await setup({ handler: () => reply(200, {}) });
    const raw = '{"b": 2,   "a":1}';
    await env.client.apiRequest(API, '/x', { method: 'POST', body: raw });
    expect(env.calls[0].body).toBe(raw);
  });

  it('parses the error envelope (code, reason, details, requestId)', async () => {
    const env = await setup({ handler: () => apiError(403, 'FORBIDDEN', { reason: 'device_inactive', status: 'lost' }) });
    const r = await env.client.apiRequest(API, '/device/me', { token: 't' });
    expect(r).toMatchObject({ ok: false, status: 403, code: 'FORBIDDEN', reason: 'device_inactive', details: { status: 'lost' }, requestId: 'req-1' });
  });

  it('reads Retry-After on 429', async () => {
    const env = await setup({ handler: () => apiError(429, 'RATE_LIMITED', {}, { 'Retry-After': '17' }) });
    const r = await env.client.apiRequest(API, '/x');
    expect(r).toMatchObject({ ok: false, status: 429, code: 'RATE_LIMITED', retryAfterS: 17 });
  });

  it('maps a non-JSON 5xx to a code from the status', async () => {
    const env = await setup({ handler: () => ({ status: 502, raw: '<html>bad gateway</html>' }) });
    const r = await env.client.apiRequest(API, '/x');
    expect(r).toMatchObject({ ok: false, status: 502, code: 'INTERNAL' });
  });

  it('returns a network error without throwing', async () => {
    const env = await setup({ handler: () => 'network' });
    const r = await env.client.apiRequest(API, '/x');
    expect(r).toMatchObject({ ok: false, status: null, network: true, code: 'NETWORK' });
  });

  it('times out', async () => {
    const env = await setup({ handler: () => 'hang' });
    const r = await env.client.apiRequest(API, '/x', { timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, status: null, network: true, timeout: true, code: 'TIMEOUT' });
  });

  it('joins base and path whatever the slashes', async () => {
    const env = await setup();
    expect(env.client.joinUrl('https://h/api/v1/', '/device/me')).toBe('https://h/api/v1/device/me');
    expect(env.client.joinUrl('https://h/api/v1', 'device/me')).toBe('https://h/api/v1/device/me');
  });
});
