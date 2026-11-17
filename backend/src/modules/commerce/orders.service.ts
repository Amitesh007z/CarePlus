import { createHash, randomBytes } from 'node:crypto';
import { audit, type AuditContext } from '../../common/audit.js';
import { AppError, notFound } from '../../common/errors/AppError.js';
import { pageMeta, pageWindow, type PageQuery } from '../../common/http.js';
import { istDateOf } from '../../common/time.js';
import type { Database, Queryable } from '../../infrastructure/database/pool.js';
import { assertDispensable, dispensingChecks, fulfilInTx, type StoredStatus } from '../prescriptions/prescriptions.service.js';
import { lockCart } from './cart.service.js';
import { enqueueOrderConfirmation, dispatchNotifications, type Mailer } from './notifications.js';
import { explainStored, inrToPaise, paiseToInr, priceOrder } from './pricing.js';
import { resolveTransition, type OrderAction, type OrderActor, type OrderStatus } from './order-status.js';
import { recordRejections, verifyOrderPrescriptions } from './verification.js';

export interface PlaceInput {
  addressId: string;
  paymentMethod: 'MOCK_CARD' | 'COD';
}

interface MedicineRow {
  id: string;
  sku: string;
  name: string;
  strength: string | null;
  pack_size: string;
  rx_required: boolean;
  active: boolean;
  stock_qty: number;
  price_inr: string;
}

interface CartLineRow {
  id: string;
  medicine_id: string;
  quantity: number;
  prescription_id: string | null;
}

/** Returns the request fingerprint. The same key with a different body is refused, never silently replayed. */
const fingerprint = (input: PlaceInput): string => createHash('sha256').update(JSON.stringify({ a: input.addressId, p: input.paymentMethod })).digest('hex');

/**
 * Prescription checks at placement, under lock. The cart must hold exactly the prescribed medicines and quantities,
 * and the prescription must still be issued, unexpired, unfulfilled, not with a pharmacy, and free of allergy and
 * major-interaction conflicts.
 */
async function checkPrescriptionForOrder(tx: Queryable, patientId: string, rxId: string, lines: CartLineRow[], now: Date): Promise<void> {
  const rx = (await tx.query<{ patient_user_id: string; status: StoredStatus; valid_till: string | null }>(
    `SELECT patient_user_id, status, to_char(valid_till, 'YYYY-MM-DD') AS valid_till FROM prescriptions WHERE id = $1 FOR UPDATE`,
    [rxId],
  )).rows[0];
  if (!rx || rx.patient_user_id !== patientId) throw new AppError(422, 'PRESCRIPTION_INVALID', 'A prescription in your cart is no longer valid');
  assertDispensable(rx.status, rx.valid_till, istDateOf(now));
  const open = await tx.query('SELECT 1 FROM fulfilments WHERE prescription_id = $1 AND status <> $2', [rxId, 'REJECTED']);
  if (open.rowCount) throw new AppError(409, 'WITH_PHARMACY', 'This prescription is already with a pharmacy');

  const prescribed = (await tx.query<{ medicine_id: string; quantity: number; name: string }>(
    `SELECT pi.medicine_id, pi.quantity, pi.medicine_name_snapshot AS name FROM prescription_items pi WHERE pi.prescription_id = $1`,
    [rxId],
  )).rows;
  const want = new Map(prescribed.map((p) => [p.medicine_id, p.quantity]));
  const have = new Map(lines.map((l) => [l.medicine_id, l.quantity]));
  const same = want.size === have.size && [...want].every(([id, q]) => have.get(id) === q);
  if (!same) {
    throw new AppError(
      422,
      'PRESCRIPTION_MISMATCH',
      'The cart must contain exactly the medicines and quantities on this prescription. Buy it again from the prescription.',
      prescribed.map((p) => ({ path: `items.${p.name}`, message: `${p.quantity} prescribed` })),
    );
  }

  const checks = await dispensingChecks(tx, rxId);
  if (checks.allergyMatches.length > 0) {
    throw new AppError(422, 'ALLERGY_CONFLICT', 'A medicine matches a recorded allergy and cannot be bought', checks.allergyMatches.map((m) => ({ path: `items.${m.medicineSku}`, message: m.medicineName })));
  }
  if (checks.majorInteractions.length > 0) {
    throw new AppError(422, 'INTERACTION_BLOCKED', 'A major drug interaction applies and this order cannot be placed', checks.majorInteractions.map((r) => ({ path: 'items', message: r.effect })));
  }
}

/**
 * Places an order. Everything that matters happens inside one transaction, in this order:
 * cart lock -> idempotency -> address -> cart lines -> medicine locks -> prescription checks -> stock check ->
 * repricing -> order and immutable snapshots -> stock decrement and ledger -> payment -> prescription fulfilled ->
 * cart cleared -> confirmation queued -> audit. The confirmation email is sent only after commit, and a failure
 * there cannot undo the order.
 */
export async function placeOrder(
  db: Database,
  patientId: string,
  idempotencyKey: string,
  input: PlaceInput,
  ctx: AuditContext,
  mailer: Mailer | null,
  now: Date = new Date(),
): Promise<{ orderId: string; replayed: boolean }> {
  const hash = fingerprint(input);
  const replayOf = async (tx: Queryable): Promise<{ orderId: string; replayed: boolean } | null> => {
    const prior = (await tx.query<{ id: string; request_hash: string }>(
      'SELECT id, request_hash FROM orders WHERE patient_user_id = $1 AND idempotency_key = $2',
      [patientId, idempotencyKey],
    )).rows[0];
    if (!prior) return null;
    if (prior.request_hash !== hash) {
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This checkout key was already used for a different order. Start a new checkout.');
    }
    return { orderId: prior.id, replayed: true };
  };

  let outcome: { orderId: string; replayed: boolean };
  try {
    outcome = await db.transaction(async (tx) => {
      // 1. The cart lock serialises every order for this patient, so the idempotency check below is race-free.
      const cartId = await lockCart(tx, patientId);
      const prior = await replayOf(tx);
      if (prior) return prior;

      // 2. Address must belong to the patient. The snapshot is stored on the order.
      const addr = (await tx.query<{ label: string; line: string; city: string; state: string; pincode: string }>(
        'SELECT label, line, city, state, pincode FROM patient_addresses WHERE id = $1 AND patient_user_id = $2',
        [input.addressId, patientId],
      )).rows[0];
      if (!addr) throw new AppError(422, 'ADDRESS_NOT_FOUND', 'Choose a delivery address from your saved addresses');

      // 3. Cart lines, then medicine rows locked in id order (no deadlocks between concurrent orders).
      const lines = (await tx.query<CartLineRow>(
        'SELECT id, medicine_id, quantity, prescription_id FROM cart_items WHERE cart_id = $1 ORDER BY medicine_id',
        [cartId],
      )).rows;
      if (lines.length === 0) throw new AppError(422, 'CART_EMPTY', 'Your cart is empty');
      const meds = (await tx.query<MedicineRow>(
        `SELECT id, sku, name, strength, pack_size, rx_required, active, stock_qty, price_inr
           FROM medicines WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [lines.map((l) => l.medicine_id)],
      )).rows;
      const medById = new Map(meds.map((m) => [m.id, m]));

      // 4. Every line is re-validated here, not only when it was added to the cart.
      for (const l of lines) {
        const m = medById.get(l.medicine_id)!;
        if (!m.active) throw new AppError(422, 'MEDICINE_UNAVAILABLE', `${m.name} is no longer available`);
        if (m.rx_required && !l.prescription_id) {
          throw new AppError(422, 'RX_REQUIRED', `${m.name} needs a valid prescription. Buy it from your prescription.`);
        }
      }
      const rxIds = [...new Set(lines.flatMap((l) => (l.prescription_id ? [l.prescription_id] : [])))].sort();
      for (const rxId of rxIds) {
        await checkPrescriptionForOrder(tx, patientId, rxId, lines.filter((l) => l.prescription_id === rxId), now);
      }

      // 5. Stock, under lock. A short line refuses the whole order.
      const short = lines
        .filter((l) => medById.get(l.medicine_id)!.stock_qty < l.quantity)
        .map((l) => ({ path: `items.${medById.get(l.medicine_id)!.name}`, message: `${medById.get(l.medicine_id)!.stock_qty} in stock, ${l.quantity} requested` }));
      if (short.length) throw new AppError(409, 'INSUFFICIENT_STOCK', 'Not enough stock for part of this order', short);

      // 6. Reprice from the database. The client's view of prices is never used.
      const isRx = rxIds.length > 0;
      const priced = priceOrder(
        lines.map((l) => ({ unitPaise: inrToPaise(medById.get(l.medicine_id)!.price_inr), quantity: l.quantity })),
        isRx,
      );

      // 7. The order header with its address and money snapshot.
      const seq = (await tx.query<{ n: string }>(`SELECT nextval('order_number_seq')::text AS n`)).rows[0]!.n;
      const orderNumber = `ORD-${istDateOf(now).slice(0, 4)}-${seq.padStart(6, '0')}`;
      const order = (await tx.query<{ id: string }>(
        `INSERT INTO orders (order_number, patient_user_id, idempotency_key, request_hash, status, is_prescription_order,
            subtotal_inr, discount_inr, delivery_fee_inr, total_inr, payment_method, address_snapshot, placed_at)
         VALUES ($1, $2, $3, $4, 'PLACED', $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          orderNumber, patientId, idempotencyKey, hash, isRx,
          paiseToInr(priced.subtotalPaise), paiseToInr(priced.discountPaise), paiseToInr(priced.deliveryFeePaise), paiseToInr(priced.totalPaise),
          input.paymentMethod, JSON.stringify(addr), now.toISOString(),
        ],
      )).rows[0]!;
      const orderId = order.id;
      await tx.query(`INSERT INTO order_events (order_id, action, from_status, to_status, actor_user_id, actor_role) VALUES ($1, 'place', NULL, 'PLACED', $2, 'PATIENT')`, [orderId, patientId]);

      // 8. Immutable line snapshots. Later catalogue edits do not change these rows.
      let lineNo = 0;
      for (const l of lines) {
        const m = medById.get(l.medicine_id)!;
        lineNo++;
        const unit = inrToPaise(m.price_inr);
        await tx.query(
          `INSERT INTO order_items (order_id, line_no, medicine_id, sku_snapshot, name_snapshot, strength_snapshot, pack_size_snapshot,
              rx_required_snapshot, unit_price_inr, quantity, line_total_inr, prescription_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [orderId, lineNo, m.id, m.sku, m.name, m.strength, m.pack_size, m.rx_required, paiseToInr(unit), l.quantity, paiseToInr(unit * l.quantity), l.prescription_id],
        );
      }

      // 9. Decrement stock and write one ledger row per line. The CHECK constraint is the last line of defence.
      for (const l of lines) {
        const m = medById.get(l.medicine_id)!;
        const balance = m.stock_qty - l.quantity;
        await tx.query('UPDATE medicines SET stock_qty = $2 WHERE id = $1', [m.id, balance]);
        await tx.query(
          `INSERT INTO stock_movements (medicine_id, delta, balance_after, reason, order_id, actor_user_id)
           VALUES ($1, $2, $3, 'ORDER', $4, $5)`,
          [m.id, -l.quantity, balance, orderId, patientId],
        );
        m.stock_qty = balance; // keep the in-memory view in step for any later line
      }

      // 10. Simulated payment. COD is collected on delivery; the mock card succeeds immediately.
      const gatewayRef = `SIM-${randomBytes(12).toString('hex')}`;
      await tx.query(
        `INSERT INTO payments (order_id, method, status, amount_inr, gateway_reference)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, input.paymentMethod, input.paymentMethod === 'COD' ? 'PENDING' : 'SUCCEEDED', paiseToInr(priced.totalPaise), gatewayRef],
      );

      // 11. Prescriptions used in this order are fulfilled in the same commit (C5 hook).
      for (const rxId of rxIds) await fulfilInTx(tx, rxId, ctx, now);

      // 12. The cart is cleared only as part of the successful commit.
      await tx.query('DELETE FROM cart_items WHERE cart_id = $1', [cartId]);
      await enqueueOrderConfirmation(tx, orderId, patientId);
      await audit(tx, ctx, {
        action: 'ORDER_PLACED',
        entityType: 'order',
        entityId: orderId,
        after: { orderNumber, totalInr: paiseToInr(priced.totalPaise), lines: lines.length, prescriptionOrder: isRx, paymentMethod: input.paymentMethod },
      });
      return { orderId, replayed: false };
    });
  } catch (err) {
    // A concurrent request with the same key can only collide on the unique key if the cart lock is bypassed.
    // Recover by returning the committed order rather than failing.
    if ((err as { code?: string; constraint?: string }).code === '23505' && (err as { constraint?: string }).constraint === 'orders_idempotency_uniq') {
      const prior = await replayOf(db);
      if (prior) return prior;
    }
    throw err;
  }

  if (!outcome.replayed) {
    // After commit only. Email is never inside the transaction, and a failure here does not affect the order.
    await dispatchNotifications(db, mailer, now).catch(() => undefined);
  }
  return outcome;
}

// ---- Views ----------------------------------------------------------------------------------------

export interface OrderView {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  isPrescriptionOrder: boolean;
  placedAt: string;
  items: {
    lineNo: number;
    name: string;
    sku: string;
    strength: string | null;
    packSize: string;
    unitPriceInr: number;
    quantity: number;
    lineTotalInr: number;
    rxRequired: boolean;
    prescriptionRxNumber: string | null;
  }[];
  subtotalInr: number;
  discountInr: number;
  deliveryFeeInr: number;
  totalInr: number;
  paymentMethod: 'MOCK_CARD' | 'COD';
  paymentStatus: 'SUCCEEDED' | 'PENDING' | 'COLLECTED' | 'REFUNDED' | 'VOIDED' | null;
  address: { label: string; line: string; city: string; state: string; pincode: string };
  timeline: Record<'placedAt' | 'verifiedAt' | 'packedAt' | 'dispatchedAt' | 'deliveredAt' | 'rejectedAt' | 'cancelledAt', string | null>;
  statusReason: string | null;
  explanation: string[];
  /** Pharmacist view only. */
  patient?: { name: string };
  prescriptions?: { id: string; rxNumber: string | null; validTill: string | null }[];
  events?: { action: string; fromStatus: string | null; toStatus: string; actorRole: string; reason: string | null; at: string }[];
}

interface HeaderRow {
  id: string;
  order_number: string;
  patient_user_id: string;
  status: OrderStatus;
  is_prescription_order: boolean;
  subtotal_inr: string;
  discount_inr: string;
  delivery_fee_inr: string;
  total_inr: string;
  payment_method: 'MOCK_CARD' | 'COD';
  address_snapshot: OrderView['address'];
  status_reason: string | null;
  placed_at: Date;
  verified_at: Date | null;
  packed_at: Date | null;
  dispatched_at: Date | null;
  delivered_at: Date | null;
  rejected_at: Date | null;
  cancelled_at: Date | null;
  patient_name: string;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function orderDetail(db: Queryable, orderId: string, viewer: OrderActor, patientId?: string): Promise<OrderView> {
  const h = (await db.query<HeaderRow>(
    `SELECT o.*, pp.full_name AS patient_name FROM orders o JOIN patient_profiles pp ON pp.user_id = o.patient_user_id
      WHERE o.id = $1 ${viewer === 'PATIENT' ? 'AND o.patient_user_id = $2' : ''}`,
    viewer === 'PATIENT' ? [orderId, patientId] : [orderId],
  )).rows[0];
  if (!h) throw notFound('Order not found');
  const items = (await db.query<{
    line_no: number; name_snapshot: string; sku_snapshot: string; strength_snapshot: string | null; pack_size_snapshot: string;
    unit_price_inr: string; quantity: number; line_total_inr: string; rx_required_snapshot: boolean; rx_number: string | null;
  }>(
    `SELECT oi.line_no, oi.name_snapshot, oi.sku_snapshot, oi.strength_snapshot, oi.pack_size_snapshot, oi.unit_price_inr,
            oi.quantity, oi.line_total_inr, oi.rx_required_snapshot, p.rx_number
       FROM order_items oi LEFT JOIN prescriptions p ON p.id = oi.prescription_id
      WHERE oi.order_id = $1 ORDER BY oi.line_no`,
    [orderId],
  )).rows;
  const pay = (await db.query<{ status: OrderView['paymentStatus'] }>('SELECT status FROM payments WHERE order_id = $1', [orderId])).rows[0];
  const units = items.reduce((s, i) => s + i.quantity, 0);
  const priced = explainStored(inrToPaise(h.subtotal_inr), h.is_prescription_order, units);

  const view: OrderView = {
    id: h.id,
    orderNumber: h.order_number,
    status: h.status,
    isPrescriptionOrder: h.is_prescription_order,
    placedAt: h.placed_at.toISOString(),
    items: items.map((i) => ({
      lineNo: i.line_no,
      name: i.name_snapshot,
      sku: i.sku_snapshot,
      strength: i.strength_snapshot,
      packSize: i.pack_size_snapshot,
      unitPriceInr: Number(i.unit_price_inr),
      quantity: i.quantity,
      lineTotalInr: Number(i.line_total_inr),
      rxRequired: i.rx_required_snapshot,
      prescriptionRxNumber: i.rx_number,
    })),
    subtotalInr: Number(h.subtotal_inr),
    discountInr: Number(h.discount_inr),
    deliveryFeeInr: Number(h.delivery_fee_inr),
    totalInr: Number(h.total_inr),
    paymentMethod: h.payment_method,
    paymentStatus: pay?.status ?? null,
    address: h.address_snapshot,
    timeline: {
      placedAt: iso(h.placed_at),
      verifiedAt: iso(h.verified_at),
      packedAt: iso(h.packed_at),
      dispatchedAt: iso(h.dispatched_at),
      deliveredAt: iso(h.delivered_at),
      rejectedAt: iso(h.rejected_at),
      cancelledAt: iso(h.cancelled_at),
    } as OrderView['timeline'],
    statusReason: h.status_reason,
    explanation: priced.explanation,
  };
  if (viewer === 'PHARMACIST') {
    view.events = (await db.query<{ action: string; from_status: string | null; to_status: string; actor_role: string; reason: string | null; created_at: Date }>(
      'SELECT action, from_status, to_status, actor_role, reason, created_at FROM order_events WHERE order_id = $1 ORDER BY created_at',
      [orderId],
    )).rows.map((e) => ({ action: e.action, fromStatus: e.from_status, toStatus: e.to_status, actorRole: e.actor_role, reason: e.reason, at: e.created_at.toISOString() }));
    view.patient = { name: h.patient_name };
    view.prescriptions = (await db.query<{ id: string; rx_number: string | null; valid_till: string | null }>(
      `SELECT DISTINCT p.id, p.rx_number, to_char(p.valid_till, 'YYYY-MM-DD') AS valid_till FROM order_items oi
         JOIN prescriptions p ON p.id = oi.prescription_id WHERE oi.order_id = $1`,
      [orderId],
    )).rows.map((r) => ({ id: r.id, rxNumber: r.rx_number, validTill: r.valid_till }));
  }
  return view;
}

export async function listPatientOrders(db: Queryable, patientId: string, q: PageQuery) {
  const w = pageWindow(q);
  const [rows, count] = await Promise.all([
    db.query<{ id: string; order_number: string; status: OrderStatus; total_inr: string; placed_at: Date; is_prescription_order: boolean; units: number }>(
      `SELECT o.id, o.order_number, o.status, o.total_inr, o.placed_at, o.is_prescription_order,
              (SELECT COALESCE(SUM(quantity), 0)::int FROM order_items oi WHERE oi.order_id = o.id) AS units
         FROM orders o WHERE o.patient_user_id = $1 ORDER BY o.placed_at DESC LIMIT $2 OFFSET $3`,
      [patientId, w.limit, w.offset],
    ),
    db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM orders WHERE patient_user_id = $1', [patientId]),
  ]);
  return {
    items: rows.rows.map((r) => ({
      id: r.id,
      orderNumber: r.order_number,
      status: r.status,
      totalInr: Number(r.total_inr),
      placedAt: r.placed_at.toISOString(),
      itemCount: r.units,
      isPrescriptionOrder: r.is_prescription_order,
    })),
    meta: pageMeta(q, count.rows[0]?.n ?? 0),
  };
}

const QUEUE_VIEWS = {
  queue: ['PLACED'],
  active: ['VERIFIED', 'PACKED', 'OUT_FOR_DELIVERY'],
  done: ['DELIVERED', 'REJECTED', 'CANCELLED'],
} as const;
export type OrderQueueView = keyof typeof QUEUE_VIEWS;

export async function listPharmacyOrders(db: Queryable, view: OrderQueueView, q: PageQuery) {
  const statuses = [...QUEUE_VIEWS[view]];
  const w = pageWindow(q);
  const where = 'FROM orders o JOIN patient_profiles pp ON pp.user_id = o.patient_user_id WHERE o.status = ANY($1::text[])';
  const [rows, count] = await Promise.all([
    db.query<{ id: string; order_number: string; status: OrderStatus; total_inr: string; placed_at: Date; is_prescription_order: boolean; patient_name: string; units: number }>(
      `SELECT o.id, o.order_number, o.status, o.total_inr, o.placed_at, o.is_prescription_order, pp.full_name AS patient_name,
              (SELECT COALESCE(SUM(quantity), 0)::int FROM order_items oi WHERE oi.order_id = o.id) AS units
         ${where} ORDER BY o.placed_at ASC LIMIT $2 OFFSET $3`,
      [statuses, w.limit, w.offset],
    ),
    db.query<{ n: number }>(`SELECT COUNT(*)::int AS n ${where}`, [statuses]),
  ]);
  return {
    items: rows.rows.map((r) => ({
      id: r.id,
      orderNumber: r.order_number,
      status: r.status,
      totalInr: Number(r.total_inr),
      placedAt: r.placed_at.toISOString(),
      itemCount: r.units,
      isPrescriptionOrder: r.is_prescription_order,
      patientName: r.patient_name,
    })),
    meta: pageMeta(q, count.rows[0]?.n ?? 0),
  };
}

// ---- Transitions ----------------------------------------------------------------------------------

/**
 * Applies one lifecycle action. Verify records the pharmacist's checks per prescription. A rejected or cancelled
 * order returns its stock exactly once, enforced by the order's stock_restored flag and a unique ledger index.
 * Refunds and voids are simulated and recorded on the payment row.
 */
export async function transitionOrder(
  db: Database,
  actor: { role: OrderActor; userId: string },
  orderId: string,
  action: OrderAction,
  reason: string | null,
  ctx: AuditContext,
  now: Date = new Date(),
): Promise<OrderView> {
  await db.transaction(async (tx) => {
    const o = (await tx.query<{ id: string; patient_user_id: string; status: OrderStatus; stock_restored: boolean; payment_method: string }>(
      'SELECT id, patient_user_id, status, stock_restored, payment_method FROM orders WHERE id = $1 FOR UPDATE',
      [orderId],
    )).rows[0];
    if (!o || (actor.role === 'PATIENT' && o.patient_user_id !== actor.userId)) throw notFound('Order not found');
    const rule = resolveTransition(o.status, action, actor.role, reason);

    if (action === 'verify') await verifyOrderPrescriptions(tx, orderId, o.patient_user_id, actor.userId, now);
    if (action === 'reject') await recordRejections(tx, orderId, actor.userId, reason, now);

    if (rule.restoresStock && !o.stock_restored) await restoreStock(tx, orderId, actor.userId);

    if (action === 'deliver') {
      await tx.query(`UPDATE payments SET status = 'COLLECTED' WHERE order_id = $1 AND method = 'COD' AND status = 'PENDING'`, [orderId]);
    }
    if (rule.restoresStock) {
      await tx.query(`UPDATE payments SET status = 'REFUNDED' WHERE order_id = $1 AND method = 'MOCK_CARD' AND status = 'SUCCEEDED'`, [orderId]);
      await tx.query(`UPDATE payments SET status = 'VOIDED' WHERE order_id = $1 AND method = 'COD' AND status = 'PENDING'`, [orderId]);
    }

    // The stamp column comes from the fixed rule table, never from the request.
    await tx.query(
      `UPDATE orders SET status = $2, ${rule.stamp} = now(), status_reason = $3, stock_restored = stock_restored OR $4 WHERE id = $1`,
      [orderId, rule.to, reason, rule.restoresStock],
    );
    await tx.query(
      `INSERT INTO order_events (order_id, action, from_status, to_status, actor_user_id, actor_role, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [orderId, action, o.status, rule.to, actor.userId, actor.role, reason],
    );
    await audit(tx, ctx, { action: `ORDER_${action.toUpperCase()}`, entityType: 'order', entityId: orderId, after: { status: rule.to } });
  });
  return orderDetail(db, orderId, actor.role, actor.userId);
}

async function restoreStock(tx: Queryable, orderId: string, actorId: string): Promise<void> {
  const lines = (await tx.query<{ medicine_id: string; quantity: number }>(
    'SELECT medicine_id, quantity FROM order_items WHERE order_id = $1 ORDER BY medicine_id',
    [orderId],
  )).rows;
  const stock = await tx.query<{ id: string; stock_qty: number }>(
    'SELECT id, stock_qty FROM medicines WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [lines.map((l) => l.medicine_id)],
  );
  const onHand = new Map(stock.rows.map((s) => [s.id, s.stock_qty]));
  for (const l of lines) {
    const balance = (onHand.get(l.medicine_id) ?? 0) + l.quantity;
    await tx.query('UPDATE medicines SET stock_qty = $2 WHERE id = $1', [l.medicine_id, balance]);
    await tx.query(
      `INSERT INTO stock_movements (medicine_id, delta, balance_after, reason, order_id, actor_user_id)
       VALUES ($1, $2, $3, 'ORDER_RESTORE', $4, $5)`,
      [l.medicine_id, l.quantity, balance, orderId, actorId],
    );
  }
}

