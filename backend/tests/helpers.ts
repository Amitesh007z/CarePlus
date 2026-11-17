import { createApp } from '../src/app.js';
import { createLogger } from '../src/common/logger.js';
import type { Database } from '../src/infrastructure/database/pool.js';
import { createPasswordHasher } from '../src/modules/auth/password.js';
import type { QueryResult } from 'pg';

export const TEST_ORIGIN = 'http://localhost:5173';

type Handler = (text: string) => unknown[];

/** Fake database: `handler` returns rows for each query, or throws to simulate an outage. */
export function fakeDb(handler: Handler): Database {
  const db: Database = {
    query: async (text: string) => ({ rows: handler(text) }) as unknown as QueryResult<never>,
    transaction: (fn) => fn(db),
    close: async () => undefined,
  };
  return db;
}

/** A database whose migrations table reports every file in the folder as applied. */
export async function currentDb(): Promise<Database> {
  const { readMigrationFiles } = await import('../src/infrastructure/database/migrate.js');
  const files = await readMigrationFiles();
  return fakeDb((text) => {
    if (text.includes('to_regclass')) return [{ t: 'schema_migrations' }];
    if (text.includes('FROM schema_migrations')) return files.map((f) => ({ name: f.name, checksum: f.checksum }));
    return [{ '?column?': 1 }];
  });
}

/** Cheap Argon2id parameters keep tests fast; production uses the OWASP defaults. */
export const testHasher = createPasswordHasher({ memoryCost: 1024, timeCost: 1, parallelism: 1 });

export function buildApp(db: Database, overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({
    env: { APP_ORIGIN: [TEST_ORIGIN], NODE_ENV: 'test', SESSION_TTL_HOURS: 8 },
    db,
    logger: createLogger('silent'),
    hasher: testHasher,
    ...overrides,
  });
}
