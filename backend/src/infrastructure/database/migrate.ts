import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './pool.js';
import { getDriver } from './driver.js';

export const DEFAULT_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../migrations',
);

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationStatus {
  applied: number;
  pending: string[];
  drifted: string[];
}

const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

export async function readMigrationFiles(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => FILE_PATTERN.test(n)).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(path.join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

/** Read-only: compares files on disk with the schema_migrations table. */
export async function getMigrationStatus(
  db: Pick<Database, 'query'>,
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationStatus> {
  const files = await readMigrationFiles(dir);
  const exists = await db.query<{ t: string | null }>(`SELECT to_regclass('public.schema_migrations') AS t`);
  const applied = new Map<string, string>();
  if (exists.rows[0]?.t) {
    const rows = await db.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    for (const r of rows.rows) applied.set(r.name, r.checksum);
  }
  return {
    applied: applied.size,
    pending: files.filter((f) => !applied.has(f.name)).map((f) => f.name),
    drifted: files.filter((f) => applied.has(f.name) && applied.get(f.name) !== f.checksum).map((f) => f.name),
  };
}

const LOCK_ID = 727_001; // arbitrary app-wide advisory lock key

/**
 * Applies pending migrations, each in its own transaction, serialized by an advisory lock.
 * Use a DIRECT (non-pooled) connection string: advisory locks and DDL need a stable session.
 * Refuses to run if an already-applied file has been edited.
 */
export async function runMigrations(
  connectionString: string,
  dir: string = DEFAULT_MIGRATIONS_DIR,
  log: (msg: string) => void = () => undefined,
): Promise<string[]> {
  const files = await readMigrationFiles(dir);
  const client = new (getDriver().Client)({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  const ran: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const existing = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const done = new Map(existing.rows.map((r) => [r.name, r.checksum]));
    for (const f of files) {
      const recorded = done.get(f.name);
      if (recorded) {
        if (recorded !== f.checksum) throw new Error(`Migration ${f.name} was modified after being applied`);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(f.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [f.name, f.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      log(`applied ${f.name}`);
      ran.push(f.name);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    await client.end();
  }
  return ran;
}
