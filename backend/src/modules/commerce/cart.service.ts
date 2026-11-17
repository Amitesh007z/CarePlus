import { AppError, notFound } from '../../common/errors/AppError.js';
import { istDateOf } from '../../common/time.js';
import type { Database, Queryable } from '../../infrastructure/database/pool.js';
import { assertDispensable, effectiveStatus, type StoredStatus } from '../prescriptions/prescriptions.service.js';
import { availabilityOf, type Availability } from '../medicines/catalogue.service.js';
import { inrToPaise, paiseToInr, priceOrder } from './pricing.js';

/** Lines hold only identity and quantity. Names, prices and stock are always read from the database. */
export const MAX_LINE_QUANTITY = 100;

export interface CartLine {
  id: string;
  quantity: number;
  source: 'CATALOGUE' | 'PRESCRIPTION';
  locked: boolean;
  prescription: { id: string; rxNumber: string | null } | null;
  medicine: { id: string; sku: string; name: string; strength: string | null; packSize: string; rxRequired: boolean; availability: Availability };
  unitPriceInr: number;
  lineTotalInr: number;
  problems: string[];
}

export interface CartSummary {
  subtotalInr: number;
  discountInr: number;
  deliveryFeeInr: number;
  totalInr: number;
  isPrescriptionOrder: boolean;
  freeDelivery: boolean;
  explanation: string[];
}

export interface CartView {
  items: CartLine[];
  summary: CartSummary;
  blockers: string[];
}

interface JoinedLine {
  id: string;
  quantity: number;
  prescription_id: string | null;
  rx_number: string | null;
  rx_status: StoredStatus | null;
  rx_valid_till: string | null;
  medicine_id: string;
  sku: string;
  name: string;
  strength: string | null;
  pack_size: string;
  rx_required: boolean;
  active: boolean;
  stock_qty: number;
  price_inr: string;
  fulfilment_open: boolean | null;
}

const LINES_SQL = `SELECT ci.id, ci.quantity, ci.prescription_id, p.rx_number, p.status AS rx_status,
    to_char(p.valid_till, 'YYYY-MM-DD') AS rx_valid_till,
    m.id AS medicine_id, m.sku, m.name, m.strength, m.pack_size, m.rx_required, m.active, m.stock_qty, m.price_inr,
    (SELECT COUNT(*) > 0 FROM fulfilments f WHERE f.prescription_id = ci.prescription_id AND f.status <> 'REJECTED') AS fulfilment_open
  FROM cart_items ci
  JOIN carts c ON c.id = ci.cart_id
  JOIN medicines m ON m.id = ci.medicine_id
  LEFT JOIN prescriptions p ON p.id = ci.prescription_id
  WHERE c.patient_user_id = $1
  ORDER BY ci.created_at, ci.id`;

/** Per-line problems. The checkout repeats every one of these under lock, so this is guidance only. */
function problemsFor(l: JoinedLine, today: string): string[] {
  const out: string[] = [];
  if (!l.active) out.push('This medicine is no longer available');
  if (l.prescription_id === null && l.rx_required) out.push('Prescription required: buy it from a valid prescription');
  if (l.prescription_id !== null) {
    const status = effectiveStatus(l.rx_status ?? 'FULFILLED', l.rx_valid_till, today);
    if (status !== 'ISSUED') out.push(`Prescription ${l.rx_number ?? ''} is ${status.toLowerCase()}`.replace('  ', ' '));
    if (l.fulfilment_open) out.push('This prescription is already with a pharmacy');
  }
  if (l.quantity > l.stock_qty) out.push(l.stock_qty > 0 ? `Only ${l.stock_qty} in stock` : 'Out of stock');
  return out;
}

export async function buildCart(db: Queryable, patientId: string, now: Date = new Date()): Promise<CartView> {
  const today = istDateOf(now);
  const rows = (await db.query<JoinedLine>(LINES_SQL, [patientId])).rows;
  const items: CartLine[] = rows.map((l) => {
    const unit = inrToPaise(l.price_inr);
    return {
      id: l.id,
      quantity: l.quantity,
      source: l.prescription_id ? 'PRESCRIPTION' : 'CATALOGUE',
      locked: l.prescription_id !== null,
      prescription: l.prescription_id ? { id: l.prescription_id, rxNumber: l.rx_number } : null,
      medicine: {
        id: l.medicine_id,
        sku: l.sku,
        name: l.name,
        strength: l.strength,
        packSize: l.pack_size,
        rxRequired: l.rx_required,
        availability: availabilityOf(l.stock_qty),
      },
      unitPriceInr: paiseToInr(unit),
      lineTotalInr: paiseToInr(unit * l.quantity),
      problems: problemsFor(l, today),
    };
  });
  const priced = priceOrder(
    rows.map((l) => ({ unitPaise: inrToPaise(l.price_inr), quantity: l.quantity })),
    rows.some((l) => l.prescription_id !== null),
  );
  return {
    items,
    summary: {
      subtotalInr: paiseToInr(priced.subtotalPaise),
      discountInr: paiseToInr(priced.discountPaise),
      deliveryFeeInr: paiseToInr(priced.deliveryFeePaise),
      totalInr: paiseToInr(priced.totalPaise),
      isPrescriptionOrder: priced.isPrescriptionOrder,
      freeDelivery: priced.freeDelivery,
      explanation: rows.length ? priced.explanation : [],
    },
    blockers: [...new Set(items.flatMap((i) => i.problems))],
  };
}

/** Creates the patient's cart if missing. Safe under concurrent calls. */
export async function ensureCart(db: Queryable, patientId: string): Promise<string> {
  await db.query('INSERT INTO carts (patient_user_id) VALUES ($1) ON CONFLICT (patient_user_id) DO NOTHING', [patientId]);
  const r = await db.query<{ id: string }>('SELECT id FROM carts WHERE patient_user_id = $1', [patientId]);
  return r.rows[0]!.id;
}

/** Locks the cart row. Every cart change and every order placement for this patient serialises here. */
export async function lockCart(tx: Queryable, patientId: string): Promise<string> {
  const cartId = await ensureCart(tx, patientId);
  await tx.query('SELECT id FROM carts WHERE id = $1 FOR UPDATE', [cartId]);
  return cartId;
}

export async function addCatalogueItem(db: Database, patientId: string, medicineId: string, quantity: number, now: Date = new Date()): Promise<CartView> {
  await db.transaction(async (tx) => {
    const cartId = await lockCart(tx, patientId);
    const m = (await tx.query<{ active: boolean; rx_required: boolean }>('SELECT active, rx_required FROM medicines WHERE id = $1', [medicineId])).rows[0];
    if (!m || !m.active) throw new AppError(422, 'MEDICINE_UNAVAILABLE', 'This medicine is not available');
    if (m.rx_required) {
      throw new AppError(422, 'RX_REQUIRED', 'Prescription medicines can only be bought from a valid prescription in your records');
    }
    const existing = (await tx.query<{ quantity: number; prescription_id: string | null }>(
      'SELECT quantity, prescription_id FROM cart_items WHERE cart_id = $1 AND medicine_id = $2',
      [cartId, medicineId],
    )).rows[0];
    if (existing?.prescription_id) {
      throw new AppError(409, 'PRESCRIPTION_LINE_LOCKED', 'This medicine is on a prescription in your cart. Its quantity is fixed by the prescription.');
    }
    const next = (existing?.quantity ?? 0) + quantity;
    if (next > MAX_LINE_QUANTITY) throw new AppError(422, 'QUANTITY_LIMIT', `You can buy at most ${MAX_LINE_QUANTITY} of one medicine per order`);
    await tx.query(
      `INSERT INTO cart_items (cart_id, medicine_id, quantity) VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, medicine_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
      [cartId, medicineId, next],
    );
  });
  return buildCart(db, patientId, now);
}

async function ownedLine(tx: Queryable, patientId: string, itemId: string) {
  const r = await tx.query<{ id: string; prescription_id: string | null; cart_id: string }>(
    `SELECT ci.id, ci.prescription_id, ci.cart_id FROM cart_items ci JOIN carts c ON c.id = ci.cart_id
      WHERE ci.id = $1 AND c.patient_user_id = $2 FOR UPDATE OF ci`,
    [itemId, patientId],
  );
  if (!r.rows[0]) throw notFound('Cart item not found');
  return r.rows[0];
}

export async function updateQuantity(db: Database, patientId: string, itemId: string, quantity: number, now: Date = new Date()): Promise<CartView> {
  await db.transaction(async (tx) => {
    await lockCart(tx, patientId);
    const line = await ownedLine(tx, patientId, itemId);
    if (line.prescription_id) {
      throw new AppError(422, 'PRESCRIPTION_LINE_LOCKED', 'Quantities from a prescription are fixed. Remove the prescription from your cart to change them.');
    }
    await tx.query('UPDATE cart_items SET quantity = $2 WHERE id = $1', [itemId, quantity]);
  });
  return buildCart(db, patientId, now);
}

export async function removeItem(db: Database, patientId: string, itemId: string, now: Date = new Date()): Promise<CartView> {
  await db.transaction(async (tx) => {
    await lockCart(tx, patientId);
    const line = await ownedLine(tx, patientId, itemId);
    if (line.prescription_id) {
      throw new AppError(422, 'PRESCRIPTION_LINE_LOCKED', 'Remove the whole prescription from your cart instead of one medicine');
    }
    await tx.query('DELETE FROM cart_items WHERE id = $1', [itemId]);
  });
  return buildCart(db, patientId, now);
}

export async function removePrescription(db: Database, patientId: string, rxId: string, now: Date = new Date()): Promise<CartView> {
  await db.transaction(async (tx) => {
    const cartId = await lockCart(tx, patientId);
    await tx.query('DELETE FROM cart_items WHERE cart_id = $1 AND prescription_id = $2', [cartId, rxId]);
  });
  return buildCart(db, patientId, now);
}

export async function clearCart(db: Database, patientId: string, now: Date = new Date()): Promise<CartView> {
  await db.transaction(async (tx) => {
    const cartId = await lockCart(tx, patientId);
    await tx.query('DELETE FROM cart_items WHERE cart_id = $1', [cartId]);
  });
  return buildCart(db, patientId, now);
}

/**
 * Buy from a prescription. The server reads the prescription's own items and quantities. The client supplies only
 * the prescription id. Every check here is repeated at checkout, under lock.
 */
export async function addFromPrescription(db: Database, patientId: string, rxId: string, now: Date = new Date()): Promise<CartView> {
  await db.transaction(async (tx) => {
    const cartId = await lockCart(tx, patientId);
    const rx = (await tx.query<{ patient_user_id: string; status: StoredStatus; valid_till: string | null }>(
      `SELECT patient_user_id, status, to_char(valid_till, 'YYYY-MM-DD') AS valid_till FROM prescriptions WHERE id = $1 FOR UPDATE`,
      [rxId],
    )).rows[0];
    if (!rx || rx.patient_user_id !== patientId || rx.status === 'DRAFT') throw notFound('Prescription not found');
    assertDispensable(rx.status, rx.valid_till, istDateOf(now));
    const open = await tx.query('SELECT 1 FROM fulfilments WHERE prescription_id = $1 AND status <> $2', [rxId, 'REJECTED']);
    if (open.rowCount) throw new AppError(409, 'WITH_PHARMACY', 'This prescription is already with a pharmacy. Medicines cannot be bought from it as well.');

    const items = (await tx.query<{ medicine_id: string; quantity: number; active: boolean; name: string }>(
      `SELECT pi.medicine_id, pi.quantity, m.active, m.name FROM prescription_items pi JOIN medicines m ON m.id = pi.medicine_id
        WHERE pi.prescription_id = $1 ORDER BY pi.line_no`,
      [rxId],
    )).rows;
    if (items.length === 0) throw new AppError(422, 'NO_ITEMS', 'This prescription has no medicines');
    const inactive = items.filter((i) => !i.active).map((i) => ({ path: `items.${i.name}`, message: 'No longer available' }));
    if (inactive.length) throw new AppError(422, 'MEDICINE_UNAVAILABLE', 'Some medicines on this prescription are no longer available', inactive);

    const ids = items.map((i) => i.medicine_id);
    const clash = await tx.query<{ name: string }>(
      `SELECT m.name FROM cart_items ci JOIN medicines m ON m.id = ci.medicine_id
        WHERE ci.cart_id = $1 AND ci.prescription_id IS NOT NULL AND ci.prescription_id <> $2 AND ci.medicine_id = ANY($3::uuid[])`,
      [cartId, rxId, ids],
    );
    if (clash.rowCount) {
      throw new AppError(409, 'MEDICINE_IN_OTHER_PRESCRIPTION', 'A medicine here is already in your cart from another prescription. Remove that prescription first.', clash.rows.map((c) => ({ path: 'items', message: c.name })));
    }

    // Remove any line from this prescription that is no longer on it, then set the exact lines.
    await tx.query('DELETE FROM cart_items WHERE cart_id = $1 AND prescription_id = $2 AND NOT (medicine_id = ANY($3::uuid[]))', [cartId, rxId, ids]);
    for (const i of items) {
      await tx.query(
        `INSERT INTO cart_items (cart_id, medicine_id, quantity, prescription_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (cart_id, medicine_id) DO UPDATE SET quantity = EXCLUDED.quantity, prescription_id = EXCLUDED.prescription_id`,
        [cartId, i.medicine_id, i.quantity, rxId],
      );
    }
  });
  return buildCart(db, patientId, now);
}
