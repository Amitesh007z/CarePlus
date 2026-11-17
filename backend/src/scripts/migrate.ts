import 'dotenv/config';
import { loadEnv } from '../config/env.js';
import { getDriver } from '../infrastructure/database/driver.js';
import { getMigrationStatus, runMigrations } from '../infrastructure/database/migrate.js';

const env = loadEnv();
const url = env.DIRECT_DATABASE_URL ?? env.DATABASE_URL;

if (process.argv.includes('--status')) {
  const pool = new (getDriver().Pool)({ connectionString: url, max: 1 });
  try {
    const s = await getMigrationStatus(pool);
    console.log(`applied: ${s.applied}`);
    console.log(`pending: ${s.pending.join(', ') || 'none'}`);
    console.log(`drifted: ${s.drifted.join(', ') || 'none'}`);
    process.exitCode = s.drifted.length ? 1 : 0;
  } finally {
    await pool.end();
  }
} else {
  const ran = await runMigrations(url, undefined, (m) => console.log(m));
  console.log(ran.length ? `Done: ${ran.length} migration(s) applied.` : 'Database is up to date.');
}
