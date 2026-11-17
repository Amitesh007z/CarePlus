import { audit, type AuditContext } from '../../common/audit.js';
import type { Database, Queryable } from '../../infrastructure/database/pool.js';

export interface AddressView {
  id: string;
  label: string;
  line: string;
  city: string;
  state: string;
  pincode: string;
  isDefault: boolean;
}

interface Row { id: string; label: string; line: string; city: string; state: string; pincode: string; is_default: boolean }

const COLS = 'id, label, line, city, state, pincode, is_default';
const toView = (r: Row): AddressView => ({
  id: r.id,
  label: r.label,
  line: r.line,
  city: r.city,
  state: r.state,
  pincode: r.pincode,
  isDefault: r.is_default,
});

export async function listAddresses(db: Queryable, patientId: string): Promise<AddressView[]> {
  const r = await db.query<Row>(`SELECT ${COLS} FROM patient_addresses WHERE patient_user_id = $1 ORDER BY is_default DESC, created_at`, [patientId]);
  return r.rows.map(toView);
}

/** The first address becomes the default. A new default clears the old one in the same transaction. */
export async function createAddress(
  db: Database,
  patientId: string,
  input: { label: string; line: string; city: string; state: string; pincode: string; isDefault?: boolean },
  ctx: AuditContext,
): Promise<AddressView> {
  return db.transaction(async (tx) => {
    const existing = await tx.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM patient_addresses WHERE patient_user_id = $1', [patientId]);
    const makeDefault = input.isDefault === true || (existing.rows[0]?.n ?? 0) === 0;
    if (makeDefault) await tx.query('UPDATE patient_addresses SET is_default = false WHERE patient_user_id = $1 AND is_default', [patientId]);
    const r = await tx.query<Row>(
      `INSERT INTO patient_addresses (patient_user_id, label, line, city, state, pincode, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
      [patientId, input.label, input.line, input.city, input.state, input.pincode, makeDefault],
    );
    const view = toView(r.rows[0]!);
    await audit(tx, ctx, { action: 'ADDRESS_ADDED', entityType: 'patient_address', entityId: view.id });
    return view;
  });
}
