import type { Queryable } from '../../infrastructure/database/pool.js';
import { LOW_STOCK_THRESHOLD } from '../medicines/catalogue.service.js';

/** Counts for the pharmacist home screen. Counts only: no patient data. */
export async function pharmacyDashboard(db: Queryable): Promise<{
  awaitingVerification: number;
  inProgress: number;
  deliveredToday: number;
  rejectedToday: number;
  lowStockItems: number;
  outOfStockItems: number;
  lowStockThreshold: number;
}> {
  const r = await db.query<{ awaiting: number; progress: number; delivered: number; rejected: number; low: number; out: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM orders WHERE status = 'PLACED') AS awaiting,
       (SELECT COUNT(*)::int FROM orders WHERE status IN ('VERIFIED', 'PACKED', 'OUT_FOR_DELIVERY')) AS progress,
       (SELECT COUNT(*)::int FROM orders WHERE status = 'DELIVERED' AND delivered_at >= date_trunc('day', now())) AS delivered,
       (SELECT COUNT(*)::int FROM orders WHERE status = 'REJECTED' AND rejected_at >= date_trunc('day', now())) AS rejected,
       (SELECT COUNT(*)::int FROM medicines WHERE active AND stock_qty <= $1 AND stock_qty > 0) AS low,
       (SELECT COUNT(*)::int FROM medicines WHERE active AND stock_qty = 0) AS out`,
    [LOW_STOCK_THRESHOLD],
  );
  const row = r.rows[0]!;
  return {
    awaitingVerification: row.awaiting,
    inProgress: row.progress,
    deliveredToday: row.delivered,
    rejectedToday: row.rejected,
    lowStockItems: row.low,
    outOfStockItems: row.out,
    lowStockThreshold: LOW_STOCK_THRESHOLD,
  };
}
