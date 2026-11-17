import type { Database, Queryable } from '../../infrastructure/database/pool.js';

/** Outbound mail port. The SMTP adapter is below; tests inject their own. Errors must not contain credentials. */
export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

export const MAX_NOTIFICATION_ATTEMPTS = 8;
const BASE_MS = 60_000;
const MAX_MS = 60 * 60_000;

export const notificationBackoffMs = (attempts: number): number => Math.min(BASE_MS * 2 ** Math.max(0, attempts - 1), MAX_MS);

/**
 * Written inside the order transaction. A pending notification row is durable: if the process dies after commit,
 * the row is still there and will be sent later.
 */
export async function enqueueOrderConfirmation(tx: Queryable, orderId: string, patientId: string): Promise<void> {
  await tx.query(
    `INSERT INTO notifications (kind, order_id, recipient_user_id) VALUES ('ORDER_CONFIRMATION', $1, $2)
     ON CONFLICT (order_id, kind) DO NOTHING`,
    [orderId, patientId],
  );
}

/**
 * Sends due notifications. A row is claimed with a lease before sending, so two processes never send the same
 * message at once. Failure records the error code and the next attempt time; it never affects the order.
 */
export async function dispatchNotifications(db: Database, mailer: Mailer | null, now: Date = new Date(), limit = 20): Promise<{ sent: number; failed: number }> {
  if (!mailer) return { sent: 0, failed: 0 };
  const claimed = (await db.query<{ id: string; order_id: string; recipient_user_id: string; attempts: number }>(
    `UPDATE notifications n SET attempts = n.attempts + 1, next_attempt_at = $1::timestamptz + interval '5 minutes'
      WHERE n.id IN (
        SELECT id FROM notifications
         WHERE status IN ('PENDING', 'FAILED') AND next_attempt_at <= $1 AND attempts < $2
         ORDER BY next_attempt_at LIMIT $3 FOR UPDATE SKIP LOCKED)
     RETURNING n.id, n.order_id, n.recipient_user_id, n.attempts`,
    [now.toISOString(), MAX_NOTIFICATION_ATTEMPTS, limit],
  )).rows;

  let sent = 0;
  let failed = 0;
  for (const n of claimed) {
    const info = (await db.query<{ order_number: string; total_inr: string; email: string }>(
      `SELECT o.order_number, o.total_inr, u.email FROM orders o JOIN users u ON u.id = o.patient_user_id
        WHERE o.id = $1 AND u.id = $2`,
      [n.order_id, n.recipient_user_id],
    )).rows[0];
    try {
      if (!info) throw new Error('recipient not found');
      await mailer.send({
        to: info.email,
        subject: `CarePulse order ${info.order_number} placed`,
        text: `Thank you. Your order ${info.order_number} for INR ${Number(info.total_inr).toFixed(2)} is placed. Track it in your CarePulse account. This is a fictional demo.`,
      });
      await db.query(`UPDATE notifications SET status = 'SENT', sent_at = $2, last_error = NULL WHERE id = $1`, [n.id, now.toISOString()]);
      sent++;
    } catch {
      // Keep the message generic. Provider and SMTP details are never stored.
      const retryAt = new Date(now.getTime() + notificationBackoffMs(n.attempts)).toISOString();
      await db.query(
        `UPDATE notifications SET status = 'FAILED', last_error = 'SEND_FAILED', next_attempt_at = $2 WHERE id = $1`,
        [n.id, retryAt],
      );
      failed++;
    }
  }
  return { sent, failed };
}
