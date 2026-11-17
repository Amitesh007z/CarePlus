import { createApp } from '../src/app.js';
import { createLogger } from '../src/common/logger.js';
import type { Database } from '../src/infrastructure/database/pool.js';
import type { QueryResult } from 'pg';

export const TEST_ORIGIN = 'http://localhost:5173';

type Handler = (text: string) => unknown[];

/** Fake database: `handler` returns rows for each query, or throws to simulate an outage. */
export function fakeDb(handler: Handler): Pick<Database, 'query'> {
  return {
    query: async (text: string) => ({ rows: handler(text) }) as unknown as QueryResult<never>,
  };
}

/** A database whose migrations table reports every file in the folder as applied. */
export async function currentDb(): Promise<Pick<Database, 'query'>> {
  const { readMigrationFiles } = await import('../src/infrastructure/database/migrate.js');
  const files = await readMigrationFiles();
  return fakeDb((text) => {
    if (text.includes('to_regclass')) return [{ t: 'schema_migrations' }];
    if (text.includes('FROM schema_migrations')) return files.map((f) => ({ name: f.name, checksum: f.checksum }));
    return [{ '?column?': 1 }];
  });
}

export function buildApp(db: Pick<Database, 'query'>) {
  return createApp({ env: { APP_ORIGIN: [TEST_ORIGIN] }, db, logger: createLogger('silent') });
}
