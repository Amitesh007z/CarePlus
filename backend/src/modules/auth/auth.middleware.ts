import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { AppError } from '../../common/errors/AppError.js';
import type { Queryable } from '../../infrastructure/database/pool.js';
import { resolveSession, type AuthContext, type Role } from './session.service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export const isProd = (nodeEnv: string): boolean => nodeEnv === 'production';

/** `__Host-` prefix (production) forces Secure, Path=/ and no Domain, so subdomains cannot overwrite it. */
export const cookieName = (nodeEnv: string): string => (isProd(nodeEnv) ? '__Host-cp_sid' : 'cp_sid');

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

interface AuthDeps {
  db: Queryable;
  nodeEnv: string;
}

/** 401 unless the request carries a valid, unexpired, unrevoked session. */
export function authenticate({ db, nodeEnv }: AuthDeps): RequestHandler {
  const name = cookieName(nodeEnv);
  return async (req, _res, next) => {
    const token = readCookie(req, name);
    const ctx = token ? await resolveSession(db, token) : null;
    if (!ctx) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    req.auth = ctx;
    next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie sessions: state-changing requests must echo the per-session token
 * (returned by /auth/me and /auth/login) in `X-CSRF-Token`. Cross-site pages cannot read it.
 */
export const csrfGuard: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const sent = req.header('x-csrf-token');
  const expected = req.auth?.csrfToken;
  const a = Buffer.from(sent ?? '');
  const b = Buffer.from(expected ?? '');
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError(403, 'CSRF_INVALID', 'Missing or invalid CSRF token');
  }
  next();
};

/** 403 unless the authenticated actor holds one of the roles. Must run after `authenticate`. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    if (!roles.includes(req.auth.role)) throw new AppError(403, 'FORBIDDEN', 'You do not have access to this resource');
    next();
  };
}

/** Rejects cross-origin browser writes from origins outside the allow-list (also blocks login CSRF). */
export function originGuard(allowed: string[]): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.header('origin');
    if (origin && !allowed.includes(origin)) throw new AppError(403, 'FORBIDDEN_ORIGIN', 'Request origin is not allowed');
    next();
  };
}

/** Standard stack for protected routes: session, CSRF on writes, then role check. */
export function protect(deps: AuthDeps, ...roles: Role[]): RequestHandler[] {
  const chain: RequestHandler[] = [authenticate(deps), csrfGuard];
  if (roles.length) chain.push(requireRole(...roles));
  return chain;
}
