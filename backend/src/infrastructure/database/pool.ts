import type pg from 'pg';
import type { Logger } from 'pino';
import { getDriver } from './driver.js';

export interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>>;
}

export interface Database extends Queryable {
  /** Runs `fn` in one transaction. Keep it short: never await LLM/SMTP/HTTP calls inside. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PoolOptions {
  connectionString: string;
  max: number;
  logger: Logger;
}

/** Bounded pool. Point `connectionString` at Neon's pooled (PgBouncer) endpoint. */
export function createDatabase({ connectionString, max, logger }: PoolOptions): Database {
  const pool = new (getDriver().Pool)({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
  });
  pool.on('error', (err) => logger.error({ err }, 'idle database client error'));
  return {
    query: (text, params) => pool.query(text, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (text, params) => client.query(text, params) });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
