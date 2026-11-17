import { Router } from 'express';
import { AppError } from '../../common/errors/AppError.js';
import { getMigrationStatus, DEFAULT_MIGRATIONS_DIR } from '../../infrastructure/database/migrate.js';
import type { Database } from '../../infrastructure/database/pool.js';

interface HealthDeps {
  db: Pick<Database, 'query'>;
  migrationsDir?: string;
}

/** /health/live: process is up. /health/ready: database reachable and migrations current. */
export function healthRouter({ db, migrationsDir = DEFAULT_MIGRATIONS_DIR }: HealthDeps): Router {
  const router = Router();

  router.get('/live', (req, res) => {
    res.json({ success: true, data: { status: 'ok' }, requestId: req.id });
  });

  router.get('/ready', async (req, res) => {
    const checks: { database: 'up' | 'down'; migrations: 'current' | 'pending' | 'drifted' | 'unknown' } = {
      database: 'down',
      migrations: 'unknown',
    };
    let counts = { applied: 0, pending: 0 };
    try {
      await db.query('SELECT 1');
      checks.database = 'up';
      const status = await getMigrationStatus(db, migrationsDir);
      counts = { applied: status.applied, pending: status.pending.length };
      checks.migrations = status.drifted.length ? 'drifted' : status.pending.length ? 'pending' : 'current';
    } catch {
      // Detail intentionally not exposed to callers; the error handler/logs cover diagnostics.
    }
    const ready = checks.database === 'up' && checks.migrations === 'current';
    if (!ready) {
      throw new AppError(503, 'NOT_READY', 'Service is not ready', [
        { path: 'database', message: checks.database },
        { path: 'migrations', message: checks.migrations },
      ]);
    }
    res.json({ success: true, data: { status: 'ready', checks, migrations: counts }, requestId: req.id });
  });

  return router;
}
