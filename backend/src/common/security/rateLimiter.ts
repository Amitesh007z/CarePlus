import type { Queryable } from '../../infrastructure/database/pool.js';

/** Fixed-window counters in PostgreSQL, so limits hold across API replicas without Redis. */
export interface RateLimiter {
  /** Records a hit and returns the count inside the current window. */
  hit(key: string, windowSec: number): Promise<number>;
  /** Current count without recording a hit. */
  count(key: string): Promise<number>;
  reset(key: string): Promise<void>;
}

export function createRateLimiter(db: Queryable): RateLimiter {
  return {
    async hit(key, windowSec) {
      const r = await db.query<{ hits: number }>(
        `INSERT INTO rate_limits (key, hits, window_ends_at)
         VALUES ($1, 1, now() + make_interval(secs => $2))
         ON CONFLICT (key) DO UPDATE SET
           hits = CASE WHEN rate_limits.window_ends_at < now() THEN 1 ELSE rate_limits.hits + 1 END,
           window_ends_at = CASE WHEN rate_limits.window_ends_at < now()
                                 THEN now() + make_interval(secs => $2) ELSE rate_limits.window_ends_at END
         RETURNING hits`,
        [key, windowSec],
      );
      return r.rows[0]?.hits ?? 1;
    },
    async count(key) {
      const r = await db.query<{ hits: number }>(
        'SELECT hits FROM rate_limits WHERE key = $1 AND window_ends_at >= now()',
        [key],
      );
      return r.rows[0]?.hits ?? 0;
    },
    async reset(key) {
      await db.query('DELETE FROM rate_limits WHERE key = $1', [key]);
    },
  };
}

export interface AuthLimits {
  windowSec: number;
  loginPerIp: number;
  loginFailuresPerIdentifier: number;
  registerPerIp: number;
}

export const DEFAULT_AUTH_LIMITS: AuthLimits = {
  windowSec: 15 * 60,
  loginPerIp: 30,
  loginFailuresPerIdentifier: 5,
  registerPerIp: 10,
};
