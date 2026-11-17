import { audit, type AuditContext } from '../../common/audit.js';
import { AppError, notFound } from '../../common/errors/AppError.js';
import { pageMeta, pageWindow, type PageQuery } from '../../common/http.js';
import { istDateOf } from '../../common/time.js';
import type { Database, Queryable } from '../../infrastructure/database/pool.js';
import { assertDispensable, dispensingChecks, fulfilInTx, effectiveStatus, type StoredStatus } from '../prescriptions/prescriptions.service.js';
import { availabilityOf, LOW_STOCK_THRESHOLD, type Availability } from '../medicines/catalogue.service.js';

/**
 * Pharmacy fulfilment. Lifecycle:
 *   QUEUED -> VERIFIED -> PACKED -> OUT_FOR_DELIVERY -> DELIVERED
 *   QUEUED | VERIFIED -> REJECTED (with a reason)
 * Packing is dispensing: it marks the prescription FULFILLED and deducts stock, in one transaction.
 * A failed step rolls back everything, so stock and prescription status never disagree.
 */
export const FULFILMENT_STATUSES = ['QUEUED', 'VERIFIED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'REJECTED'] as const;
export type FulfilmentStatus = (typeof FULFILMENT_STATUSES)[number];
export type FulfilmentAction = 'verify' | 'pack' | 'dispatch' | 'deliver' | 'reject';

const SPEC: Record<FulfilmentAction, { from: FulfilmentStatus[]; to: FulfilmentStatus; stamp: string }> = {
  verify: { from: ['QUEUED'], to: 'VERIFIED', stamp: 'verified_at' },
  pack: { from: ['VERIFIED'], to: 'PACKED', stamp: 'packed_at' },
  dispatch: { from: ['PACKED'], to: 'OUT_FOR_DELIVERY', stamp: 'dispatched_at' },
  deliver: { from: ['OUT_FOR_DELIVERY'], to: 'DELIVERED', stamp: 'delivered_at' },
  reject: { from: ['QUEUED', 'VERIFIED'], to: 'REJECTED', stamp: 'rejected_at' },
};

const QUEUE_VIEWS = {
  queue: ['QUEUED'],
  active: ['VERIFIED', 'PACKED', 'OUT_FOR_DELIVERY'],
  done: ['DELIVERED', 'REJECTED'],
} as const satisfies Record<string, FulfilmentStatus[]>;
export type QueueView = keyof typeof QUEUE_VIEWS;

// ---- Patient ------------------------------------------------------------------------------------

/** Patient-initiated: sends an issued, unexpired prescription to the pharmacy queue. One open request at a time. */
export async function sendToPharmacy(db: Database, patientId: string, rxId: string, ctx: AuditContext, now: Date = new Date()): Promise<string> {
  return db.transaction(async (tx) => {
    const r = await tx.query<{ patient_user_id: string; status: StoredStatus; valid_till: string | null }>(
      `SELECT patient_user_id, status, to_char(valid_till, 'YYYY-MM-DD') AS valid_till FROM prescriptions WHERE id = $1 FOR UPDATE`,
      [rxId],
    );
    const rx = r.rows[0];
    if (!rx || rx.patient_user_id !== patientId || rx.status === 'DRAFT') throw notFound('Prescription not found');
    assertDispensable(rx.status, rx.valid_till, istDateOf(now));
    let id: string;
    try {
      id = (await tx.query<{ id: string }>(`INSERT INTO fulfilments (prescription_id) VALUES ($1) RETURNING id`, [rxId])).rows[0]!.id;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(409, 'ALREADY_QUEUED', 'This prescription is already with a pharmacy');
      throw err;
    }
    await audit(tx, ctx, { action: 'FULFILMENT_REQUESTED', entityType: 'fulfilment', entityId: id, after: { prescriptionId: rxId } });
    return id;
  });
}

/** What the patient may see about the pharmacy step: status and dates only, never the pharmacist's identity. */
export async function patientFulfilment(db: Queryable, patientId: string, rxId: string) {
  const r = await db.query<{ id: string; status: FulfilmentStatus; requested_at: Date; verified_at: Date | null; packed_at: Date | null; dispatched_at: Date | null; delivered_at: Date | null; rejected_at: Date | null; rejection_reason: string | null }>(
    `SELECT f.id, f.status, f.requested_at, f.verified_at, f.packed_at, f.dispatched_at, f.delivered_at, f.rejected_at, f.rejection_reason
       FROM fulfilments f JOIN prescriptions p ON p.id = f.prescription_id
      WHERE p.id = $1 AND p.patient_user_id = $2
      ORDER BY f.requested_at DESC LIMIT 1`,
    [rxId, patientId],
  );
  const f = r.rows[0];
  if (!f) return null;
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    status: f.status,
    requestedAt: iso(f.requested_at),
    verifiedAt: iso(f.verified_at),
    packedAt: iso(f.packed_at),
    dispatchedAt: iso(f.dispatched_at),
    deliveredAt: iso(f.delivered_at),
    rejectedAt: iso(f.rejected_at),
    rejectionReason: f.rejection_reason,
  };
}

// ---- Pharmacist queue ---------------------------------------------------------------------------

export async function listFulfilments(db: Queryable, view: QueueView, q: PageQuery) {
  const statuses = [...QUEUE_VIEWS[view]];
  const w = pageWindow(q);
  const where = `FROM fulfilments f
    JOIN prescriptions p ON p.id = f.prescription_id
    JOIN patient_profiles pp ON pp.user_id = p.patient_user_id
    JOIN doctor_profiles d ON d.user_id = p.doctor_user_id
    WHERE f.status = ANY($1::text[])`;
  const [rows, count] = await Promise.all([
    db.query<{ id: string; status: FulfilmentStatus; requested_at: Date; rx_number: string | null; patient_name: string; doctor_name: string; item_count: number }>(
      `SELECT f.id, f.status, f.requested_at, p.rx_number, pp.full_name AS patient_name, d.display_name AS doctor_name,
              (SELECT COUNT(*)::int FROM prescription_items pi WHERE pi.prescription_id = p.id) AS item_count
         ${where} ORDER BY f.requested_at ASC LIMIT $2 OFFSET $3`,
      [statuses, w.limit, w.offset],
    ),
    db.query<{ n: number }>(`SELECT COUNT(*)::int AS n ${where}`, [statuses]),
  ]);
  return {
    items: rows.rows.map((r) => ({
      id: r.id,
      status: r.status,
      requestedAt: r.requested_at.toISOString(),
      rxNumber: r.rx_number,
      patientName: r.patient_name,
      doctorName: r.doctor_name,
      itemCount: r.item_count,
    })),
    meta: pageMeta(q, count.rows[0]?.n ?? 0),
  };
}

export async function getFulfilment(db: Queryable, id: string, now: Date = new Date()) {
  const h = (await db.query<{
    id: string; status: FulfilmentStatus; requested_at: Date; verified_at: Date | null; packed_at: Date | null;
    dispatched_at: Date | null; delivered_at: Date | null; rejected_at: Date | null; rejection_reason: string | null;
    prescription_id: string; rx_number: string | null; rx_status: StoredStatus; valid_till: string | null;
    patient_name: string; patient_dob: string; doctor_name: string; registration_no: string;
  }>(
    `SELECT f.id, f.status, f.requested_at, f.verified_at, f.packed_at, f.dispatched_at, f.delivered_at, f.rejected_at,
            f.rejection_reason, p.id AS prescription_id, p.rx_number, p.status AS rx_status,
            to_char(p.valid_till, 'YYYY-MM-DD') AS valid_till, pp.full_name AS patient_name,
            to_char(pp.dob, 'YYYY-MM-DD') AS patient_dob, d.display_name AS doctor_name, d.registration_no
       FROM fulfilments f
       JOIN prescriptions p ON p.id = f.prescription_id
       JOIN patient_profiles pp ON pp.user_id = p.patient_user_id
       JOIN doctor_profiles d ON d.user_id = p.doctor_user_id
      WHERE f.id = $1`,
    [id],
  )).rows[0];
  if (!h) throw notFound('Fulfilment not found');

  const items = (await db.query<{
    line_no: number; medicine_id: string; name: string; strength: string | null; dose: string; frequency: string;
    duration_days: number; quantity: number; instructions: string | null; stock_qty: number;
  }>(
    `SELECT pi.line_no, pi.medicine_id, pi.medicine_name_snapshot AS name, pi.strength_snapshot AS strength, pi.dose,
            pi.frequency, pi.duration_days, pi.quantity, pi.instructions, m.stock_qty
       FROM prescription_items pi JOIN medicines m ON m.id = pi.medicine_id
      WHERE pi.prescription_id = $1 ORDER BY pi.line_no`,
    [h.prescription_id],
  )).rows;
  const today = istDateOf(now);
  const stored = effectiveStatus(h.rx_status, h.valid_till, today);
  const shortfalls = items.filter((i) => i.stock_qty < i.quantity).map((i) => ({ medicineId: i.medicine_id, name: i.name, needed: i.quantity, available: i.stock_qty }));
  return {
    id: h.id,
    status: h.status,
    prescription: {
      id: h.prescription_id,
      rxNumber: h.rx_number,
      status: stored,
      validTill: h.valid_till,
      patient: { name: h.patient_name, dob: h.patient_dob },
      doctor: { name: h.doctor_name, registrationNo: h.registration_no },
    },
    items: items.map((i) => ({
      lineNo: i.line_no,
      medicineId: i.medicine_id,
      name: i.name,
      strength: i.strength,
      dose: i.dose,
      frequency: i.frequency,
      durationDays: i.duration_days,
      quantity: i.quantity,
      instructions: i.instructions,
      stockOnHand: i.stock_qty,
      availability: availabilityOf(i.stock_qty) as Availability,
    })),
    canPack: shortfalls.length === 0,
    shortfalls,
    timeline: {
      requestedAt: h.requested_at.toISOString(),
      verifiedAt: h.verified_at?.toISOString() ?? null,
      packedAt: h.packed_at?.toISOString() ?? null,
      dispatchedAt: h.dispatched_at?.toISOString() ?? null,
      deliveredAt: h.delivered_at?.toISOString() ?? null,
      rejectedAt: h.rejected_at?.toISOString() ?? null,
    },
    rejectionReason: h.rejection_reason,
  };
}

/**
 * One guarded transition. The row is locked first, so two pharmacists cannot act on the same request at once.
 * Verify re-runs the allergy and interaction checks. Pack deducts stock and fulfils the prescription in the same commit.
 */
export async function transition(
  db: Database,
  pharmacistId: string,
  id: string,
  action: FulfilmentAction,
  reason: string | null,
  ctx: AuditContext,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const f = (await tx.query<{ status: FulfilmentStatus; prescription_id: string }>(
      'SELECT status, prescription_id FROM fulfilments WHERE id = $1 FOR UPDATE',
      [id],
    )).rows[0];
    if (!f) throw notFound('Fulfilment not found');
    const spec = SPEC[action];
    if (!spec.from.includes(f.status)) {
      throw new AppError(409, 'INVALID_TRANSITION', `Cannot ${action} a request that is ${f.status.toLowerCase().replace(/_/g, ' ')}`);
    }

    if (action === 'verify') {
      const checks = await dispensingChecks(tx, f.prescription_id);
      if (checks.allergyMatches.length > 0) {
        throw new AppError(422, 'ALLERGY_CONFLICT', 'A medicine matches a recorded allergy. Do not dispense; reject this request.', checks.allergyMatches.map((m) => ({ path: `items.${m.medicineSku}`, message: `${m.medicineName} matches a recorded allergy` })));
      }
      if (checks.majorInteractions.length > 0) {
        throw new AppError(422, 'INTERACTION_BLOCKED', 'A major drug interaction applies. Do not dispense; reject this request.', checks.majorInteractions.map((r) => ({ path: 'items', message: r.effect })));
      }
    }

    if (action === 'pack') {
      await packAndDeduct(tx, id, f.prescription_id, pharmacistId, ctx, now);
    }

    const patch = action === 'reject' ? `, rejection_reason = $4` : '';
    const params: unknown[] = [id, spec.to, pharmacistId, ...(action === 'reject' ? [reason] : []), now.toISOString()];
    const stampParam = `$${params.length}`;
    await tx.query(
      `UPDATE fulfilments SET status = $2, pharmacist_user_id = $3, ${spec.stamp} = ${stampParam}${patch} WHERE id = $1`,
      params,
    );
    await audit(tx, ctx, { action: `FULFILMENT_${action.toUpperCase()}`, entityType: 'fulfilment', entityId: id, after: { status: spec.to } });
  });
}

/** Fulfils the prescription and deducts each line's quantity. Any shortfall aborts the whole pack. */
async function packAndDeduct(tx: Queryable, fulfilmentId: string, rxId: string, pharmacistId: string, ctx: AuditContext, now: Date): Promise<void> {
  const lines = (await tx.query<{ medicine_id: string; quantity: number; name: string }>(
    `SELECT pi.medicine_id, pi.quantity, pi.medicine_name_snapshot AS name FROM prescription_items pi
      WHERE pi.prescription_id = $1 ORDER BY pi.medicine_id`,
    [rxId],
  )).rows;
  // Lock stock rows in a fixed order (by id) so concurrent packs cannot deadlock.
  const stock = await tx.query<{ id: string; stock_qty: number }>(
    'SELECT id, stock_qty FROM medicines WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [lines.map((l) => l.medicine_id)],
  );
  const onHand = new Map(stock.rows.map((s) => [s.id, s.stock_qty]));
  const short = lines.filter((l) => (onHand.get(l.medicine_id) ?? 0) < l.quantity);
  if (short.length) {
    throw new AppError(409, 'INSUFFICIENT_STOCK', 'Not enough stock to pack this order', short.map((l) => ({ path: `items.${l.name}`, message: `${onHand.get(l.medicine_id) ?? 0} on hand, ${l.quantity} needed` })));
  }
  await fulfilInTx(tx, rxId, ctx, now);
  for (const l of lines) {
    const balance = (onHand.get(l.medicine_id) ?? 0) - l.quantity;
    await tx.query('UPDATE medicines SET stock_qty = $2 WHERE id = $1', [l.medicine_id, balance]);
    await tx.query(
      `INSERT INTO stock_movements (medicine_id, delta, balance_after, reason, fulfilment_id, actor_user_id)
       VALUES ($1, $2, $3, 'DISPENSE', $4, $5)`,
      [l.medicine_id, -l.quantity, balance, fulfilmentId, pharmacistId],
    );
  }
}

// ---- Stock ----------------------------------------------------------------------------------------

export async function listStock(db: Queryable, q: PageQuery & { q?: string; lowOnly?: boolean }) {
  const params: unknown[] = [];
  const cond = ['TRUE'];
  if (q.q) {
    params.push(`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    cond.push(`(name ILIKE $${params.length} OR sku ILIKE $${params.length})`);
  }
  if (q.lowOnly) cond.push(`stock_qty <= ${LOW_STOCK_THRESHOLD}`);
  const where = `WHERE ${cond.join(' AND ')}`;
  const w = pageWindow(q);
  params.push(w.limit, w.offset);
  const [rows, count] = await Promise.all([
    db.query<{ id: string; sku: string; name: string; stock_qty: number; active: boolean }>(
      `SELECT id, sku, name, stock_qty, active FROM medicines ${where} ORDER BY stock_qty ASC, name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM medicines ${where}`, params.slice(0, params.length - 2)),
  ]);
  return {
    items: rows.rows.map((r) => ({ id: r.id, sku: r.sku, name: r.name, stockOnHand: r.stock_qty, active: r.active, availability: availabilityOf(r.stock_qty) })),
    meta: pageMeta(q, count.rows[0]?.n ?? 0),
    lowStockThreshold: LOW_STOCK_THRESHOLD,
  };
}

/** Manual adjustment (receipt, count correction, write-off). Recorded as a ledger row; the balance can never go negative. */
export async function adjustStock(db: Database, actorId: string, medicineId: string, delta: number, note: string, ctx: AuditContext) {
  return db.transaction(async (tx) => {
    const m = (await tx.query<{ stock_qty: number }>('SELECT stock_qty FROM medicines WHERE id = $1 FOR UPDATE', [medicineId])).rows[0];
    if (!m) throw notFound('Medicine not found');
    const balance = m.stock_qty + delta;
    if (balance < 0) throw new AppError(409, 'INSUFFICIENT_STOCK', 'The adjustment would take stock below zero', [{ path: 'delta', message: `${m.stock_qty} on hand` }]);
    await tx.query('UPDATE medicines SET stock_qty = $2 WHERE id = $1', [medicineId, balance]);
    await tx.query(
      `INSERT INTO stock_movements (medicine_id, delta, balance_after, reason, note, actor_user_id) VALUES ($1, $2, $3, 'ADJUSTMENT', $4, $5)`,
      [medicineId, delta, balance, note, actorId],
    );
    await audit(tx, ctx, { action: 'STOCK_ADJUSTED', entityType: 'medicine', entityId: medicineId, after: { delta, balance } });
    return { stockOnHand: balance, availability: availabilityOf(balance) };
  });
}

export async function listMovements(db: Queryable, medicineId: string) {
  const r = await db.query<{ delta: number; balance_after: number; reason: string; note: string | null; created_at: Date; fulfilment_id: string | null }>(
    `SELECT delta, balance_after, reason, note, created_at, fulfilment_id FROM stock_movements
      WHERE medicine_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [medicineId],
  );
  return r.rows.map((m) => ({
    delta: m.delta,
    balanceAfter: m.balance_after,
    reason: m.reason,
    note: m.note,
    fulfilmentId: m.fulfilment_id,
    createdAt: m.created_at.toISOString(),
  }));
}
