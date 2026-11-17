import 'dotenv/config';
import { createApp } from './app.js';
import { createLogger } from './common/logger.js';
import { EnvValidationError, loadEnv } from './config/env.js';
import { createDatabase } from './infrastructure/database/pool.js';

function main(): void {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    // Fail fast before the logger exists. Message names variables only, never values.
    process.stderr.write(`${err instanceof EnvValidationError ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const logger = createLogger(env.LOG_LEVEL);
  const db = createDatabase({ connectionString: env.DATABASE_URL, max: env.DB_POOL_MAX, logger });
  const app = createApp({ env, db, logger });
  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'api listening'));

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      db.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
