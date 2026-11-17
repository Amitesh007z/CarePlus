import { Client as NeonClient, neonConfig, Pool as NeonPool } from '@neondatabase/serverless';
import pg from 'pg';
import ws from 'ws';

/**
 * Postgres driver selection.
 * - `pg` (default): plain TCP on 5432. Use this on Render/production.
 * - `neon-ws`: Neon's serverless driver (Postgres over WebSocket on 443), for networks that block 5432.
 * Both expose the same Pool/Client API, so the rest of the code is unaware of the choice.
 */
export interface Driver {
  Pool: typeof pg.Pool;
  Client: typeof pg.Client;
}

let wsConfigured = false;

export function getDriver(): Driver {
  if (process.env.DB_DRIVER === 'neon-ws') {
    if (!wsConfigured) {
      neonConfig.webSocketConstructor = ws;
      wsConfigured = true;
    }
    return { Pool: NeonPool as unknown as typeof pg.Pool, Client: NeonClient as unknown as typeof pg.Client };
  }
  return { Pool: pg.Pool, Client: pg.Client };
}
