import { AppError } from '../../common/errors/AppError.js';
import { istDateOf } from '../../common/time.js';
import type { Queryable } from '../../infrastructure/database/pool.js';
import { dispensingChecks, type StoredStatus } from '../prescriptions/prescriptions.service.js';

/**
 * The pharmacist's prescription check before a prescription order can move on. OTC-only orders skip it.
 * Each prescription must be: the ordering patient's, issued (or fulfilled by this very order), not expired, and
 * the order's lines for it must equal the prescribed medicines and quantities exactly. Allergy and major-interaction
 * conflicts also stop verification. Nothing here alters the prescription itself.
 */
export async function verifyOrderPrescriptions(tx: Queryable, orderId: string, patientId: string, verifierId: string, now: Date): Promise<void> {
  const lines = (await tx.query<{ medicine_id: string; quantity: number; prescription_id: string | null; rx_required: boolean; name: string }>(
    `SELECT oi.medicine_id, oi.quantity, oi.prescription_id, oi.rx_required_snapshot AS rx_required, oi.name_snapshot AS name
       FROM order_items oi WHERE oi.order_id = $1`,
    [orderId],
  )).rows;
  const missing = lines.filter((l) => l.rx_required && !l.prescription_id);
  if (missing.length) {
    throw new AppError(422, 'PRESCRIPTION_REQUIRED', 'A prescription-only medicine has no prescription on this order', missing.map((m) => ({ path: `items.${m.name}`, message: 'No prescription' })));
  }
  const rxIds = [...new Set(lines.flatMap((l) => (l.prescription_id ? [l.prescription_id] : [])))].sort();
  if (rxIds.length === 0) return; // OTC-only: no prescription verification

  const today = istDateOf(now);
  for (const rxId of rxIds) {
    const rx = (await tx.query<{ patient_user_id: string; status: StoredStatus; valid_till: string | null }>(
      `SELECT patient_user_id, status, to_char(valid_till, 'YYYY-MM-DD') AS valid_till FROM prescriptions WHERE id = $1`,
      [rxId],
    )).rows[0];
    if (!rx) throw new AppError(422, 'PRESCRIPTION_NOT_FOUND', 'A prescription on this order no longer exists');
    if (rx.patient_user_id !== patientId) throw new AppError(422, 'PRESCRIPTION_OWNER_MISMATCH', 'A prescription on this order belongs to another patient');
    if (rx.status === 'FULFILLED') {
      const elsewhere = await tx.query(
        `SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE oi.prescription_id = $1 AND o.id <> $2 AND o.status NOT IN ('REJECTED', 'CANCELLED')`,
        [rxId, orderId],
      );
      if (elsewhere.rowCount) throw new AppError(422, 'PRESCRIPTION_FULFILLED_ELSEWHERE', 'This prescription was already used for another order');
    } else if (rx.status !== 'ISSUED') {
      throw new AppError(422, 'PRESCRIPTION_NOT_ISSUED', `This prescription is ${rx.status.toLowerCase()}`);
    } else if (rx.valid_till !== null && today > rx.valid_till) {
      throw new AppError(422, 'PRESCRIPTION_EXPIRED', 'This prescription has expired');
    }

    const prescribed = (await tx.query<{ medicine_id: string; quantity: number; name: string }>(
      'SELECT medicine_id, quantity, medicine_name_snapshot AS name FROM prescription_items WHERE prescription_id = $1',
      [rxId],
    )).rows;
    const onOrder = lines.filter((l) => l.prescription_id === rxId);
    const want = new Map(prescribed.map((p) => [p.medicine_id, p.quantity]));
    const have = new Map(onOrder.map((l) => [l.medicine_id, l.quantity]));
    const exact = want.size === have.size && [...want].every(([id, q]) => have.get(id) === q);
    if (!exact) {
      throw new AppError(422, 'PRESCRIPTION_MISMATCH', 'The order items do not match this prescription exactly', [
        ...prescribed.filter((p) => have.get(p.medicine_id) !== p.quantity).map((p) => ({ path: `items.${p.name}`, message: `${p.quantity} prescribed` })),
        ...onOrder.filter((l) => want.get(l.medicine_id) !== l.quantity).map((l) => ({ path: `items.${l.name}`, message: 'not on the prescription, or wrong quantity' })),
      ]);
    }

    const checks = await dispensingChecks(tx, rxId);
    if (checks.allergyMatches.length > 0) throw new AppError(422, 'ALLERGY_CONFLICT', 'A medicine matches a recorded allergy. Reject this order instead.');
    if (checks.majorInteractions.length > 0) throw new AppError(422, 'INTERACTION_BLOCKED', 'A major drug interaction applies. Reject this order instead.');
    await tx.query(
      `INSERT INTO prescription_verifications (order_id, prescription_id, verifier_user_id, result, checks)
       VALUES ($1, $2, $3, 'PASSED', $4::jsonb)`,
      [orderId, rxId, verifierId, JSON.stringify({ checkedAt: now.toISOString(), allergyMatches: 0, majorInteractions: 0, lines: onOrder.length })],
    );
  }
}

/** A rejection is recorded against each prescription on the order, with the pharmacist's reason. */
export async function recordRejections(tx: Queryable, orderId: string, actorId: string, reason: string | null, now: Date): Promise<void> {
  const rxIds = (await tx.query<{ prescription_id: string }>(
    'SELECT DISTINCT prescription_id FROM order_items WHERE order_id = $1 AND prescription_id IS NOT NULL',
    [orderId],
  )).rows.map((r) => r.prescription_id);
  for (const rxId of rxIds) {
    await tx.query(
      `INSERT INTO prescription_verifications (order_id, prescription_id, verifier_user_id, result, reason, checks)
       VALUES ($1, $2, $3, 'REJECTED', $4, $5::jsonb)`,
      [orderId, rxId, actorId, reason, JSON.stringify({ checkedAt: now.toISOString() })],
    );
  }
}
