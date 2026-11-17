import 'dotenv/config';
import { createLogger } from '../common/logger.js';
import { loadEnv } from '../config/env.js';
import { createDatabase } from '../infrastructure/database/pool.js';
import { createSearchProvider } from '../modules/search/search-runtime.js';
import { INDEX_DOCTORS, INDEX_MEDICINES, type IndexName } from '../modules/search/search-provider.js';
import { drainSearchSync, reconcileIndex, reindexAll, syncStatus } from '../modules/search/search-sync.js';

/**
 * Operator commands for search. All of them go through the outbox, so they are durable and retried.
 *   setup        apply index settings to both indexes (idempotent)
 *   reindex      queue every active medicine and doctor, then drain
 *   reconcile    compare the database with each index and fix missing or stray objects
 *   drain        process due jobs once
 *   status       job counts by state
 */
const command = process.argv[2];
const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const provider = createSearchProvider(env);
const db = createDatabase({ connectionString: env.DIRECT_DATABASE_URL ?? env.DATABASE_URL, max: 2, logger });

const requireProvider = () => {
  if (!provider) throw new Error('Algolia is not configured. Set ALGOLIA_APP_ID and ALGOLIA_ADMIN_API_KEY in backend/.env.');
  return provider;
};
const INDEXES: IndexName[] = [INDEX_MEDICINES, INDEX_DOCTORS];

try {
  if (command === 'setup') {
    const p = requireProvider();
    for (const index of INDEXES) {
      await p.configure(index);
      console.log(`configured ${index}`);
    }
  } else if (command === 'reindex') {
    const r = await reindexAll({ db, provider: requireProvider(), logger });
    console.log(`reindex: queued ${r.queued}; succeeded ${r.succeeded}, retried ${r.retried}, superseded ${r.superseded}, dead ${r.dead}`);
  } else if (command === 'reconcile') {
    const p = requireProvider();
    for (const index of INDEXES) {
      const r = await reconcileIndex({ db, provider: p, logger }, index);
      console.log(`reconcile ${index}: missing ${r.missing}, stray ${r.stray}; succeeded ${r.succeeded}, retried ${r.retried}, dead ${r.dead}`);
    }
  } else if (command === 'drain') {
    const r = await drainSearchSync({ db, provider: requireProvider(), logger });
    console.log(`drain: claimed ${r.claimed}; succeeded ${r.succeeded}, retried ${r.retried}, superseded ${r.superseded}, dead ${r.dead}`);
  } else if (command === 'status') {
    console.log(JSON.stringify({ configured: provider !== null, jobs: await syncStatus(db) }, null, 2));
  } else {
    console.error('usage: search <setup|reindex|reconcile|drain|status>');
    process.exitCode = 2;
  }
} catch (err) {
  // Print the error name and message only. Provider details are already sanitised at the adapter.
  console.error(`search ${command} failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
