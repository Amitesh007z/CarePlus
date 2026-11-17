import type { CookieOptions, Request, Response } from 'express';
import { Router } from 'express';
import { createHash } from 'node:crypto';
import { AppError } from '../../common/errors/AppError.js';
import { createRateLimiter, type AuthLimits } from '../../common/security/rateLimiter.js';
import type { Database } from '../../infrastructure/database/pool.js';
import { INVALID_CREDENTIALS, registerPatient, verifyCredentials } from './auth.service.js';
import { authenticate, cookieName, csrfGuard, isProd, readCookie } from './auth.middleware.js';
import type { PasswordHasher } from './password.js';
import { createSession, revokeSessionById, revokeSessionByToken, type CreatedSession } from './session.service.js';
import { loadUserView } from './user.repository.js';
import { loginSchema, normalizeEmail, normalizeMobile, registerSchema } from './validation.js';

export interface AuthRouterDeps {
  db: Database;
  hasher: PasswordHasher;
  nodeEnv: string;
  sessionTtlHours: number;
  limits: AuthLimits;
}

export function authRouter({ db, hasher, nodeEnv, sessionTtlHours, limits }: AuthRouterDeps): Router {
  const router = Router();
  const limiter = createRateLimiter(db);
  const name = cookieName(nodeEnv);
  const authDeps = { db, nodeEnv };

  // Cross-site deployments (Vercel frontend, Render API) need SameSite=None; local dev is same-site.
  const cookieOptions = (expires?: Date): CookieOptions => ({
    httpOnly: true,
    secure: isProd(nodeEnv),
    sameSite: isProd(nodeEnv) ? 'none' : 'lax',
    path: '/',
    ...(expires ? { expires } : {}),
  });

  const setSessionCookie = (res: Response, s: CreatedSession) => res.cookie(name, s.token, cookieOptions(s.expiresAt));

  /** A rate-limiter outage must not take authentication down: fail open, but keep the signal. */
  async function guarded<T>(req: Request, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      req.log.warn({ err }, 'rate limiter unavailable');
      return fallback;
    }
  }

  const tooMany = () => new AppError(429, 'RATE_LIMITED', 'Too many attempts. Please try again later.');

  router.post('/register', async (req, res) => {
    const hits = await guarded(req, () => limiter.hit(`register:ip:${req.ip}`, limits.windowSec), 0);
    if (hits > limits.registerPerIp) throw tooMany();

    const input = registerSchema.parse(req.body);
    const userId = await registerPatient(db, hasher, input);
    const session = await createSession(db, userId, sessionTtlHours);
    setSessionCookie(res, session);
    const user = await loadUserView(db, userId);
    res.status(201).json({ success: true, data: { user, csrfToken: session.csrfToken }, requestId: req.id });
  });

  router.post('/login', async (req, res) => {
    const ipHits = await guarded(req, () => limiter.hit(`login:ip:${req.ip}`, limits.windowSec), 0);
    if (ipHits > limits.loginPerIp) throw tooMany();

    const input = loginSchema.parse(req.body);
    const idKey = `login:id:${createHash('sha256')
      .update(input.identifier.includes('@') ? normalizeEmail(input.identifier) : (normalizeMobile(input.identifier) ?? input.identifier))
      .digest('hex')}`;
    const failures = await guarded(req, () => limiter.count(idKey), 0);
    if (failures >= limits.loginFailuresPerIdentifier) throw tooMany();

    const userId = await verifyCredentials(db, hasher, input);
    if (!userId) {
      await guarded(req, () => limiter.hit(idKey, limits.windowSec), 0);
      throw INVALID_CREDENTIALS();
    }
    await guarded(req, () => limiter.reset(idKey), undefined);

    // Session rotation: a fresh token is always issued and any presented session is revoked (no fixation).
    const previous = readCookie(req, name);
    if (previous) await revokeSessionByToken(db, previous);
    const session = await createSession(db, userId, sessionTtlHours);
    setSessionCookie(res, session);
    const user = await loadUserView(db, userId);
    res.json({ success: true, data: { user, csrfToken: session.csrfToken }, requestId: req.id });
  });

  router.post('/logout', authenticate(authDeps), csrfGuard, async (req, res) => {
    await revokeSessionById(db, req.auth!.sessionId);
    res.clearCookie(name, cookieOptions());
    res.json({ success: true, data: { loggedOut: true }, requestId: req.id });
  });

  router.get('/me', authenticate(authDeps), async (req, res) => {
    const user = await loadUserView(db, req.auth!.userId);
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    res.json({ success: true, data: { user, csrfToken: req.auth!.csrfToken }, requestId: req.id });
  });

  return router;
}
