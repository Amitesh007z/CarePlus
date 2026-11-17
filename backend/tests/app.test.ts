import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp, currentDb, fakeDb, TEST_ORIGIN } from './helpers.js';

describe('health endpoints', () => {
  it('GET /health/live returns ok without touching the database', async () => {
    const app = buildApp(fakeDb(() => { throw new Error('db must not be called'); }));
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'ok' } });
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('GET /health/ready is 200 when the database is up and migrations are current', async () => {
    const res = await request(buildApp(await currentDb())).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.data.checks).toEqual({ database: 'up', migrations: 'current' });
    expect(res.body.data.migrations.pending).toBe(0);
  });

  it('GET /health/ready is 503 when the database is down, with no internals leaked', async () => {
    const app = buildApp(fakeDb(() => { throw new Error('connect ECONNREFUSED postgres://u:pw@secret-host'); }));
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('NOT_READY');
    expect(JSON.stringify(res.body)).not.toMatch(/secret-host|ECONNREFUSED|postgres:\/\//);
  });

  it('GET /health/ready is 503 when migrations are pending', async () => {
    const app = buildApp(fakeDb((t) => (t.includes('to_regclass') ? [{ t: null }] : [{ x: 1 }])));
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.error.details).toContainEqual({ path: 'migrations', message: 'pending' });
  });
});

describe('API foundation', () => {
  const app = buildApp(fakeDb(() => []));

  it('GET /api/v1/ping answers with the envelope', async () => {
    const res = await request(app).get('/api/v1/ping');
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('pong');
  });

  it('returns a JSON 404 envelope for unknown routes', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
  });

  it('echoes a safe incoming request id and replaces an unsafe one', async () => {
    const good = await request(app).get('/health/live').set('X-Request-Id', 'abc-12345678');
    expect(good.headers['x-request-id']).toBe('abc-12345678');
    const bad = await request(app).get('/health/live').set('X-Request-Id', 'x y\t<script>');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets security headers and hides x-powered-by', async () => {
    const res = await request(app).get('/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('allows only the configured CORS origin', async () => {
    const ok = await request(app).get('/api/v1/ping').set('Origin', TEST_ORIGIN);
    expect(ok.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await request(app).get('/api/v1/ping').set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects malformed JSON with 400 and no stack trace', async () => {
    const res = await request(app).post('/api/v1/ping').set('Content-Type', 'application/json').send('{"a":');
    expect(res.body.error.code).toBe('INVALID_JSON');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/\bat\s+\S+\s+\(|node_modules|stack/i);
  });

  it('rejects oversized bodies with 413', async () => {
    const res = await request(app)
      .post('/api/v1/ping')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('server startup', () => {
  it('listens on a real port and serves /health/live', async () => {
    const server = buildApp(fakeDb(() => [])).listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/health/live`);
      expect(res.status).toBe(200);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
