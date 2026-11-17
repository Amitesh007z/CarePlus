import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { getDriver } from '../src/infrastructure/database/driver.js';
import { getMigrationStatus, runMigrations } from '../src/infrastructure/database/migrate.js';

// Real-database integration tests. They only run when TEST_DATABASE_URL is set
// (use a disposable Neon branch, not production data).
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('database (integration)', () => {
  const pool = new (getDriver().Pool)({ connectionString: url, max: 2 });
  afterAll(() => pool.end());

  it('connects', async () => {
    const r = await pool.query('SELECT 1 AS ok');
    expect(r.rows[0]).toEqual({ ok: 1 });
  });

  it('applies migrations idempotently and reports a current status', async () => {
    await runMigrations(url as string);
    const second = await runMigrations(url as string);
    expect(second).toEqual([]);
    const status = await getMigrationStatus(pool);
    expect(status.pending).toEqual([]);
    expect(status.drifted).toEqual([]);
  });

  it('provides the foundation extensions and updated_at trigger function', async () => {
    const ext = await pool.query(`SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto','citext')`);
    expect(ext.rowCount).toBe(2);
    const fn = await pool.query(`SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at'`);
    expect(fn.rowCount).toBe(1);
  });
});
