import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import { createErrorHandler, notFoundHandler } from './common/errors/errorHandler.js';
import { requestId } from './common/middleware/requestId.js';
import type { Env } from './config/env.js';
import type { Database } from './infrastructure/database/pool.js';
import { healthRouter } from './modules/health/health.routes.js';

export interface AppDeps {
  env: Pick<Env, 'APP_ORIGIN'>;
  db: Pick<Database, 'query'>;
  logger: Logger;
  migrationsDir?: string;
}

export const BODY_LIMIT = '100kb';

export function createApp({ env, db, logger, migrationsDir }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id ?? 'unknown',
      // Log method and path only: no query strings, headers or bodies.
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url.split('?')[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      // Explicit allow-list. Requests without an Origin (curl, server-to-server) are not browser cross-origin.
      origin: (origin, callback) => callback(null, !origin || env.APP_ORIGIN.includes(origin)),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-Request-Id'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: BODY_LIMIT }));

  app.use('/health', healthRouter({ db, migrationsDir }));

  const api = express.Router();
  api.get('/ping', (req, res) => {
    res.json({ success: true, data: { message: 'pong', time: new Date().toISOString() }, requestId: req.id });
  });
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
