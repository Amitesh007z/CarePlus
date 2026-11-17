import { audit, type AuditContext } from '../../common/audit.js';
import { AppError, notFound } from '../../common/errors/AppError.js';
import { pageWindow, type PageQuery } from '../../common/http.js';
import type { Database, Queryable } from '../../infrastructure/database/pool.js';
import type { HealthCreate, HealthUpdate, MedicationCreate, ProfileUpdate } from './patients.schemas.js';

/** New health data needs consent. Missing or withdrawn consent is refused, never assumed. */
export const CONSENT_REQUIRED = () =>
  new AppError(422, 'CONSENT_REQUIRED', 'Health-data consent is required. Grant consent in your profile first.');

export interface HealthItemView {
  id: string;
  type: 'ALLERGY' | 'CONDITION';
  name: string;
  allergyClass: string | null;
  severity: 'MILD' | 'MODERATE' | 'SEVERE' | null;
  notedOn: string;
  active: boolean;
  notes: string | null;
}

export interface MedicationView {
  id: string;
  medicationName: string;
  dose: string | null;
  frequency: string | null;
  startedOn: string;
  endedOn: string | null;
  active: boolean;
}

interface HealthRow {
  id: string;
  type: 'ALLERGY' | 'CONDITION';
  name: string;
  allergy_class: string | null;
  severity: 'MILD' | 'MODERATE' | 'SEVERE' | null;
  noted_on: string;
  active: boolean;
  notes: string | null;
}

interface MedRow {
  id: string;
  medication_name: string;
  dose: string | null;
  frequency: string | null;
  started_on: string;
  ended_on: string | null;
  active: boolean;
}

const HEALTH_COLS = `id, type, name, allergy_class, severity, to_char(noted_on, 'YYYY-MM-DD') AS noted_on, active, notes`;
const MED_COLS = `id, medication_name, dose, frequency, to_char(started_on, 'YYYY-MM-DD') AS started_on,
  to_char(ended_on, 'YYYY-MM-DD') AS ended_on, active`;

const toHealth = (r: HealthRow): HealthItemView => ({
  id: r.id,
  type: r.type,
  name: r.name,
  allergyClass: r.allergy_class,
  severity: r.severity,
  notedOn: r.noted_on,
  active: r.active,
  notes: r.notes,
});

const toMed = (r: MedRow): MedicationView => ({
  id: r.id,
  medicationName: r.medication_name,
  dose: r.dose,
  frequency: r.frequency,
  startedOn: r.started_on,
  endedOn: r.ended_on,
  active: r.active,
});

export async function updateProfile(db: Database, userId: string, input: ProfileUpdate, ctx: AuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    const r = await tx.query(
      `UPDATE patient_profiles SET full_name = $2, dob = $3, gender = $4, blood_group = $5, address_line = $6,
         city = $7, state = $8, pincode = $9, emergency_contact_name = $10, emergency_contact_phone = $11
       WHERE user_id = $1`,
      [
        userId, input.fullName, input.dob, input.gender, input.bloodGroup, input.addressLine, input.city,
        input.state, input.pincode, input.emergencyContactName, input.emergencyContactPhone,
      ],
    );
    if (!r.rowCount) throw notFound('Profile not found');
    await audit(tx, ctx, { action: 'PROFILE_UPDATED', entityType: 'patient_profile', entityId: userId });
  });
}

export interface ConsentState {
  consentStatus: boolean;
  consentAt: string | null;
  consentWithdrawnAt: string | null;
}

/** Grant or withdraw consent. Idempotent: repeating the same state changes nothing and writes no audit row. */
export async function setConsent(db: Database, userId: string, granted: boolean, ctx: AuditContext): Promise<ConsentState> {
  return db.transaction(async (tx) => {
    const changed = await tx.query(
      granted
        ? `UPDATE patient_profiles SET consent_status = true, consent_at = now(), consent_withdrawn_at = NULL
            WHERE user_id = $1 AND consent_status = false`
        : `UPDATE patient_profiles SET consent_status = false, consent_withdrawn_at = now()
            WHERE user_id = $1 AND consent_status = true`,
      [userId],
    );
    if (changed.rowCount) {
      await audit(tx, ctx, {
        action: granted ? 'CONSENT_GRANTED' : 'CONSENT_WITHDRAWN',
        entityType: 'patient_profile',
        entityId: userId,
      });
    }
    const r = await tx.query<{ consent_status: boolean; consent_at: Date | null; consent_withdrawn_at: Date | null }>(
      'SELECT consent_status, consent_at, consent_withdrawn_at FROM patient_profiles WHERE user_id = $1',
      [userId],
    );
    const row = r.rows[0];
    if (!row) throw notFound('Profile not found');
    return {
      consentStatus: row.consent_status,
      consentAt: row.consent_at?.toISOString() ?? null,
      consentWithdrawnAt: row.consent_withdrawn_at?.toISOString() ?? null,
    };
  });
}

export async function listHealth(
  db: Queryable,
  userId: string,
  q: PageQuery & { type?: 'ALLERGY' | 'CONDITION' },
): Promise<{ items: HealthItemView[]; total: number }> {
  const w = pageWindow(q);
  const where = `WHERE patient_user_id = $1 AND ($2::text IS NULL OR type = $2)`;
  const [rows, count] = await Promise.all([
    db.query<HealthRow>(
      `SELECT ${HEALTH_COLS} FROM health_info ${where} ORDER BY active DESC, noted_on DESC, created_at DESC LIMIT $3 OFFSET $4`,
      [userId, q.type ?? null, w.limit, w.offset],
    ),
    db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM health_info ${where}`, [userId, q.type ?? null]),
  ]);
  return { items: rows.rows.map(toHealth), total: count.rows[0]?.n ?? 0 };
}

export async function addHealthItem(db: Database, userId: string, input: HealthCreate, ctx: AuditContext): Promise<HealthItemView> {
  return db.transaction(async (tx) => {
    // Consent is checked inside the same statement that inserts, so a concurrent withdrawal cannot slip through.
    let r;
    try {
      r = await tx.query<HealthRow>(
        `INSERT INTO health_info (patient_user_id, type, name, allergy_class, severity, noted_on, notes)
         SELECT $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::date, $7::text
           FROM patient_profiles WHERE user_id = $1::uuid AND consent_status = true
         RETURNING ${HEALTH_COLS}`,
        [userId, input.type, input.name, input.allergyClass ?? null, input.severity ?? null, input.notedOn, input.notes ?? null],
      );
    } catch (err) {
      // The partial unique index rejects a second active entry with the same name (case-insensitive).
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'DUPLICATE', 'This entry is already on your record');
      }
      throw err;
    }
    const row = r.rows[0];
    if (!row) throw CONSENT_REQUIRED();
    await audit(tx, ctx, { action: 'HEALTH_ITEM_ADDED', entityType: 'health_info', entityId: row.id, after: { type: row.type } });
    return toHealth(row);
  });
}

/** Editing or resolving an existing record does not need consent; it never adds data. */
export async function updateHealthItem(db: Database, userId: string, id: string, patch: HealthUpdate, ctx: AuditContext): Promise<HealthItemView> {
  return db.transaction(async (tx) => {
    const r = await tx.query<HealthRow>(
      `UPDATE health_info SET active = COALESCE($3::boolean, active), severity = COALESCE($4::text, severity),
              notes = COALESCE($5::text, notes)
        WHERE id = $1 AND patient_user_id = $2
       RETURNING ${HEALTH_COLS}`,
      [id, userId, patch.active ?? null, patch.severity ?? null, patch.notes ?? null],
    );
    const row = r.rows[0];
    if (!row) throw notFound('Health record not found');
    await audit(tx, ctx, { action: 'HEALTH_ITEM_UPDATED', entityType: 'health_info', entityId: id, after: { active: row.active } });
    return toHealth(row);
  });
}

export async function listMedications(db: Queryable, userId: string, q: PageQuery): Promise<{ items: MedicationView[]; total: number }> {
  const w = pageWindow(q);
  const [rows, count] = await Promise.all([
    db.query<MedRow>(
      `SELECT ${MED_COLS} FROM patient_medications WHERE patient_user_id = $1
       ORDER BY active DESC, started_on DESC, created_at DESC LIMIT $2 OFFSET $3`,
      [userId, w.limit, w.offset],
    ),
    db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM patient_medications WHERE patient_user_id = $1', [userId]),
  ]);
  return { items: rows.rows.map(toMed), total: count.rows[0]?.n ?? 0 };
}

export async function addMedication(db: Database, userId: string, input: MedicationCreate, ctx: AuditContext): Promise<MedicationView> {
  return db.transaction(async (tx) => {
    const r = await tx.query<MedRow>(
      `INSERT INTO patient_medications (patient_user_id, medication_name, dose, frequency, started_on)
       SELECT $1::uuid, $2::text, $3::text, $4::text, $5::date
         FROM patient_profiles WHERE user_id = $1::uuid AND consent_status = true
       RETURNING ${MED_COLS}`,
      [userId, input.medicationName, input.dose ?? null, input.frequency ?? null, input.startedOn],
    );
    const row = r.rows[0];
    if (!row) throw CONSENT_REQUIRED();
    await audit(tx, ctx, { action: 'MEDICATION_ADDED', entityType: 'patient_medication', entityId: row.id });
    return toMed(row);
  });
}

/** Stopping keeps the record for history. It is idempotent and does not need consent. */
export async function stopMedication(db: Database, userId: string, id: string, ctx: AuditContext): Promise<MedicationView> {
  return db.transaction(async (tx) => {
    const r = await tx.query<MedRow>(
      `UPDATE patient_medications
          SET active = false, ended_on = COALESCE(ended_on, (now() AT TIME ZONE 'Asia/Kolkata')::date)
        WHERE id = $1 AND patient_user_id = $2
       RETURNING ${MED_COLS}`,
      [id, userId],
    );
    const row = r.rows[0];
    if (!row) throw notFound('Medication not found');
    await audit(tx, ctx, { action: 'MEDICATION_STOPPED', entityType: 'patient_medication', entityId: id });
    return toMed(row);
  });
}
