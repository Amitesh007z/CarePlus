import type { Env } from '../../config/env.js';
import type { Database } from '../../infrastructure/database/pool.js';
import { createAlgoliaProvider } from './algolia.adapter.js';
import type { SearchProvider } from './search-provider.js';
import { drainSearchSync, type DrainReport } from './search-sync.js';

/** Null when Algolia is not configured. Callers then run on PostgreSQL search and the outbox waits durably. */
export function createSearchProvider(env: Pick<Env, 'ALGOLIA_APP_ID' | 'ALGOLIA_ADMIN_API_KEY' | 'ALGOLIA_SEARCH_API_KEY' | 'ALGOLIA_TIMEOUT_MS'>): SearchProvider | null {
  if (!env.ALGOLIA_APP_ID || !env.ALGOLIA_ADMIN_API_KEY) return null;
  return createAlgoliaProvider({
    appId: env.ALGOLIA_APP_ID,
    adminKey: env.ALGOLIA_ADMIN_API_KEY,
    searchKey: env.ALGOLIA_SEARCH_API_KEY,
    timeoutMs: env.ALGOLIA_TIMEOUT_MS,
  });
}

/**
 * Polls the outbox. A tick never overlaps the previous one in this process, and SKIP LOCKED keeps several
 * processes safe. Returns a stop function for graceful shutdown.
 */
export function startSearchWorker(opts: {
  db: Database;
  provider: SearchProvider;
  logger: { warn: (obj: object, msg: string) => void; info: (obj: object, msg: string) => void };
  intervalMs?: number;
  onReport?: (r: DrainReport) => void;
}): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const report = await drainSearchSync({ db: opts.db, provider: opts.provider, logger: opts.logger });
      if (report.claimed > 0) opts.onReport?.(report);
    } catch (err) {
      // A database hiccup must not kill the process. The lease will return any claimed jobs.
      opts.logger.warn({ err: (err as Error).name }, 'search worker tick failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 2000);
  timer.unref();
  return () => clearInterval(timer);
}
