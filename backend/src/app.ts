import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import { createErrorHandler, notFoundHandler } from './common/errors/errorHandler.js';
import { requestId } from './common/middleware/requestId.js';
import type { Env } from './config/env.js';
import { DEFAULT_AUTH_LIMITS, type AuthLimits } from './common/security/rateLimiter.js';
import type { Database } from './infrastructure/database/pool.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { originGuard } from './modules/auth/auth.middleware.js';
import { createPasswordHasher, type PasswordHasher } from './modules/auth/password.js';
import { dashboardsRouter } from './modules/dashboards/dashboards.routes.js';
import { healthRouter } from './modules/health/health.routes.js';

export interface AppDeps {
  env: Pick<Env, 'APP_ORIGIN'> & Partial<Pick<Env, 'NODE_ENV' | 'SESSION_TTL_HOURS'>>;
  db: Database;
  logger: Logger;
  migrationsDir?: string;
  hasher?: PasswordHasher;
  limits?: AuthLimits;
}

export const BODY_LIMIT = '100kb';

export function createApp({ env, db, logger, migrationsDir, hasher, limits }: AppDeps): Express {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const app = express();
  app.disable('x-powered-by');
  // Behind Render's proxy, trust one hop so req.ip (rate limiting) is the real client address.
  app.set('trust proxy', nodeEnv === 'production' ? 1 : false);

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
      allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-Request-Id', 'X-CSRF-Token'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(originGuard(env.APP_ORIGIN));

  app.use('/health', healthRouter({ db, migrationsDir }));

  const api = express.Router();
  api.get('/ping', (req, res) => {
    res.json({ success: true, data: { message: 'pong', time: new Date().toISOString() }, requestId: req.id });
  });
  api.use(
    '/auth',
    authRouter({
      db,
      hasher: hasher ?? createPasswordHasher(),
      nodeEnv,
      sessionTtlHours: env.SESSION_TTL_HOURS ?? 8,
      limits: limits ?? DEFAULT_AUTH_LIMITS,
    }),
  );
  api.use(dashboardsRouter({ db, nodeEnv }));
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
