import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/common/errors/AppError.js';
import { createErrorHandler } from '../src/common/errors/errorHandler.js';
import { createLogger } from '../src/common/logger.js';
import { requestId } from '../src/common/middleware/requestId.js';

function capture() {
  const lines: string[] = [];
  const logger = createLogger('info', { write: (s: string) => void lines.push(s) });
  return { logger, lines };
}

describe('error handler', () => {
  function appWith(route: express.RequestHandler) {
    const { logger, lines } = capture();
    const app = express();
    app.use(requestId);
    app.get('/x', route);
    app.use(createErrorHandler(logger));
    return { app, lines };
  }

  it('maps AppError to its status and code', async () => {
    const { app } = appWith(() => { throw new AppError(409, 'CONFLICT', 'Already booked'); });
    const res = await request(app).get('/x');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT', message: 'Already booked' });
  });

  it('logs deliberate 5xx AppErrors as warnings without a stack trace', async () => {
    const { app, lines } = appWith(() => { throw new AppError(503, 'NOT_READY', 'Service is not ready'); });
    const res = await request(app).get('/x');
    expect(res.status).toBe(503);
    const out = lines.join('');
    expect(out).toContain('request failed');
    expect(out).not.toContain('unhandled error');
    expect(out).not.toContain('stack');
  });

  it('maps ZodError to 422 with field details', async () => {
    const { app } = appWith(() => { z.object({ pincode: z.string().regex(/^\d{6}$/) }).parse({ pincode: 'abc' }); });
    const res = await request(app).get('/x');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].path).toBe('pincode');
  });

  it('hides unexpected errors from the client but logs them', async () => {
    const { app, lines } = appWith(() => { throw new Error('SELECT * FROM users failed: password=hunter2'); });
    const res = await request(app).get('/x');
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', details: [] });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(lines.join('')).toContain('unhandled error');
  });
});

describe('logger redaction', () => {
  it('redacts credentials and cookies', () => {
    const { logger, lines } = capture();
    logger.info({
      req: { headers: { authorization: 'Bearer abc', cookie: 'sid=SESSIONVALUE' } },
      body: { password: 'Demo@1234', token: 'tok-123' },
      password: 'Demo@1234',
      connectionString: 'postgres://u:dbpass@h/db',
    }, 'sample');
    const out = lines.join('');
    for (const secret of ['Bearer abc', 'SESSIONVALUE', 'Demo@1234', 'tok-123', 'dbpass']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[REDACTED]');
  });
});
