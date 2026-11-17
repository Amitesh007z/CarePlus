import { audit, type AuditContext } from '../../common/audit.js';
import { AppError, notFound } from '../../common/errors/AppError.js';
import { pageWindow, type PageQuery } from '../../common/http.js';
import { addDays, istDateOf } from '../../common/time.js';
import type { Database, Queryable } from '../../infrastructure/database/pool.js';
import { ageFromDob } from '../auth/user.repository.js';
import { CONSENT_WITHDRAWN } from '../consultations/consultations.service.js';
import { chronicIneligible, interactionsAmong, type InteractionView } from '../medicines/catalogue.service.js';
import type { ItemCreate, ItemUpdate } from './prescriptions.schemas.js';

/** Allergy policy is configuration in code, not a model decision. BLOCK refuses issuance. */
export const ALLERGY_POLICY = 'BLOCK' as const;
export const VALID_DAYS = 30;
const MAX_ITEMS = 30;

export type StoredStatus = 'DRAFT' | 'ISSUED' | 'FULFILLED' | 'SUPERSEDED';
export type EffectiveStatus = StoredStatus | 'EXPIRED';

export interface AllergyMatch {
  medicineSku: string;
  medicineName: string;
  allergyClass: string;
  matchedOn: 'ALLERGY_CLASS' | 'ALLERGY_NAME';
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Deterministic match: a medicine's allergy class equals a recorded allergy's class (or, when the
 * allergy has no class, its name). Exact, case-insensitive comparison only. Cross-reactivity is never inferred.
 */
export function matchAllergies(
  items: { sku: string; name: string; allergyClass: string | null }[],
  allergies: { name: string; allergyClass: string | null }[],
): AllergyMatch[] {
  const out: AllergyMatch[] = [];
  for (const item of items) {
    if (!item.allergyClass) continue;
    const wanted = norm(item.allergyClass);
    for (const a of allergies) {
      const recorded = a.allergyClass ? norm(a.allergyClass) : norm(a.name);
      if (recorded === wanted) {
        out.push({
          medicineSku: item.sku,
          medicineName: item.name,
          allergyClass: item.allergyClass,
          matchedOn: a.allergyClass ? 'ALLERGY_CLASS' : 'ALLERGY_NAME',
        });
        break;
      }
    }
  }
  return out;
}

/** EXPIRED is derived: an issued prescription is expired once today (clinic time) is after valid_till. */
export function effectiveStatus(stored: StoredStatus, validTill: string | null, today: string): EffectiveStatus {
  return stored === 'ISSUED' && validTill !== null && today > validTill ? 'EXPIRED' : stored;
}

/** Pharmacy hook (used in C5): only a live, issued, unexpired prescription may be dispensed. */
export function assertDispensable(stored: StoredStatus, validTill: string | null, today: string): void {
  const status = effectiveStatus(stored, validTill, today);
  if (status === 'ISSUED') return;
  if (status === 'FULFILLED') throw new AppError(409, 'ALREADY_FULFILLED', 'This prescription has already been fulfilled and cannot be reused');
  if (status === 'EXPIRED') throw new AppError(422, 'EXPIRED', 'This prescription has expired');
  if (status === 'SUPERSEDED') throw new AppError(422, 'SUPERSEDED', 'This prescription was replaced by a newer one');
  throw new AppError(422, 'NOT_ISSUED', 'Only an issued prescription can be used');
}

export const formatRxNumber = (seq: number, year: string): string => `CP-${year}-${String(seq).padStart(6, '0')}`;

export interface ItemView {
  id: string;
  lineNo: number;
  medicine: { id: string; sku: string; name: string; strength: string | null };
  allergyClass: string | null;
  dose: string;
  frequency: string;
  durationDays: number;
  instructions: string | null;
  quantity: number;
}

export interface PrescriptionView {
  id: string;
  rxNumber: string | null;
  status: EffectiveStatus;
  consultationId: string;
  patient: { id: string; name: string; age: number };
  doctor: { id: string; name: string; specialty: string; registrationNo: string };
  advice: string | null;
  issuedAt: string | null;
  validTill: string | null;
  fulfilledAt: string | null;
  replacesId: string | null;
  supersededById: string | null;
  items: ItemView[];
  allergyCheck: { policy: string; matches: AllergyMatch[]; checkedAt: string } | null;
  validityDays: number;
  /** Live checks for drafts. Null for issued records, which carry their checks at issue time. */
  checks: {
    allergyMatches: AllergyMatch[];
    interactions: InteractionView[];
    notChronicEligible: { id: string; name: string }[];
    blockers: string[];
    canIssue: boolean;
  } | null;
}

interface HeaderRow {
  id: string;
  rx_number: string | null;
  status: StoredStatus;
  consultation_id: string;
  consultation_status: 'DRAFT' | 'FINALIZED';
  patient_user_id: string;
  patient_name: string;
  dob: string;
  doctor_user_id: string;
  doctor_name: string;
  specialty: string;
  registration_no: string;
  advice: string | null;
  issued_at: Date | null;
  valid_till: string | null;
  fulfilled_at: Date | null;
  replaces_prescription_id: string | null;
  superseded_by_id: string | null;
  allergy_check: { policy: string; matches: AllergyMatch[]; checkedAt: string } | null;
  validity_days: number;
}

interface RxRow {
  id: string;
  status: StoredStatus;
  consultation_id: string;
  consultation_status: 'DRAFT' | 'FINALIZED';
  patient_user_id: string;
  doctor_user_id: string;
  replaces_prescription_id: string | null;
  valid_till: string | null;
  consent_status: boolean;
  validity_days: number;
}

const HEADER_SQL = `SELECT p.id, p.rx_number, p.status, p.consultation_id, c.status AS consultation_status,
  p.patient_user_id, pp.full_name AS patient_name, to_char(pp.dob, 'YYYY-MM-DD') AS dob,
  p.doctor_user_id, d.display_name AS doctor_name, d.specialty, d.registration_no, p.advice, p.issued_at,
  to_char(p.valid_till, 'YYYY-MM-DD') AS valid_till, p.fulfilled_at, p.replaces_prescription_id,
  p.superseded_by_id, p.allergy_check, p.validity_days
  FROM prescriptions p
  JOIN consultations c ON c.id = p.consultation_id
  JOIN patient_profiles pp ON pp.user_id = p.patient_user_id
  JOIN doctor_profiles d ON d.user_id = p.doctor_user_id`;

const RX_SQL = `SELECT p.id, p.status, p.consultation_id, c.status AS consultation_status, p.patient_user_id,
  p.doctor_user_id, p.replaces_prescription_id, to_char(p.valid_till, 'YYYY-MM-DD') AS valid_till, pp.consent_status,
  p.validity_days
  FROM prescriptions p
  JOIN consultations c ON c.id = p.consultation_id
  JOIN patient_profiles pp ON pp.user_id = p.patient_user_id
  WHERE p.id = $1`;

/** Loads a prescription the caller owns as the issuing doctor. Other doctors get 404; withdrawn consent gets 403. */
async function rxForDoctor(db: Queryable, doctorId: string, id: string, lock: boolean): Promise<RxRow> {
  const r = await db.query<RxRow>(`${RX_SQL} ${lock ? 'FOR UPDATE OF p' : ''}`, [id]);
  const row = r.rows[0];
  if (!row || row.doctor_user_id !== doctorId) throw notFound('Prescription not found');
  if (!row.consent_status) throw CONSENT_WITHDRAWN();
  return row;
}

async function activeAllergies(db: Queryable, patientId: string) {
  const r = await db.query<{ name: string; allergy_class: string | null }>(
    `SELECT name, allergy_class FROM health_info WHERE patient_user_id = $1 AND type = 'ALLERGY' AND active`,
    [patientId],
  );
  return r.rows.map((a) => ({ name: a.name, allergyClass: a.allergy_class }));
}

interface ItemRow {
  id: string;
  line_no: number;
  medicine_id: string;
  sku: string;
  medicine_name: string;
  strength: string | null;
  allergy_class: string | null;
  dose: string;
  frequency: string;
  duration_days: number;
  instructions: string | null;
  quantity: number;
}

const ITEM_SQL = `SELECT pi.id, pi.line_no, pi.medicine_id, m.sku, pi.medicine_name_snapshot AS medicine_name,
  pi.strength_snapshot AS strength, pi.allergy_class_snapshot AS allergy_class, pi.dose, pi.frequency,
  pi.duration_days, pi.instructions, pi.quantity
  FROM prescription_items pi JOIN medicines m ON m.id = pi.medicine_id
  WHERE pi.prescription_id = $1 ORDER BY pi.line_no`;

async function itemsOf(db: Queryable, rxId: string): Promise<ItemRow[]> {
  return (await db.query<ItemRow>(ITEM_SQL, [rxId])).rows;
}

const toItem = (r: ItemRow): ItemView => ({
  id: r.id,
  lineNo: r.line_no,
  medicine: { id: r.medicine_id, sku: r.sku, name: r.medicine_name, strength: r.strength },
  allergyClass: r.allergy_class,
  dose: r.dose,
  frequency: r.frequency,
  durationDays: r.duration_days,
  instructions: r.instructions,
  quantity: r.quantity,
});

/** Assembles the full view. `today` is passed in so expiry is deterministic in tests. */
async function buildView(db: Queryable, id: string, today: string): Promise<PrescriptionView> {
  const h = (await db.query<HeaderRow>(`${HEADER_SQL} WHERE p.id = $1`, [id])).rows[0];
  if (!h) throw notFound('Prescription not found');
  const items = (await itemsOf(db, id)).map(toItem);
  const stored = h.status;
  const isDraft = stored === 'DRAFT';

  let checks: PrescriptionView['checks'] = null;
  if (isDraft) {
    const rawItems = await itemsOf(db, id);
    const medicineIds = rawItems.map((i) => i.medicine_id);
    const matches = matchAllergies(
      rawItems.map((i) => ({ sku: i.sku, name: i.medicine_name, allergyClass: i.allergy_class })),
      await activeAllergies(db, h.patient_user_id),
    );
    const interactions = await interactionsAmong(db, medicineIds);
    const notChronicEligible = h.validity_days === 90 ? await chronicIneligible(db, medicineIds) : [];
    const blockers: string[] = [];
    if (h.consultation_status !== 'FINALIZED') blockers.push('Finalize the consultation before issuing');
    if (items.length === 0) blockers.push('Add at least one medicine');
    if (matches.length > 0) blockers.push('A medicine matches a recorded allergy');
    if (interactions.some((i) => i.severity === 'MAJOR')) blockers.push('A major drug interaction blocks issuing this prescription');
    if (notChronicEligible.length > 0) blockers.push('90-day validity needs chronic-eligible medicines only');
    checks = { allergyMatches: matches, interactions, notChronicEligible, blockers, canIssue: blockers.length === 0 };
  }

  return {
    id: h.id,
    rxNumber: h.rx_number,
    status: effectiveStatus(stored, h.valid_till, today),
    consultationId: h.consultation_id,
    patient: { id: h.patient_user_id, name: h.patient_name, age: ageFromDob(h.dob) },
    doctor: { id: h.doctor_user_id, name: h.doctor_name, specialty: h.specialty, registrationNo: h.registration_no },
    advice: h.advice,
    issuedAt: h.issued_at ? h.issued_at.toISOString() : null,
    validTill: h.valid_till,
    fulfilledAt: h.fulfilled_at ? h.fulfilled_at.toISOString() : null,
    replacesId: h.replaces_prescription_id,
    supersededById: h.superseded_by_id,
    items,
    allergyCheck: h.allergy_check,
    validityDays: h.validity_days,
    checks,
  };
}

const todayIst = () => istDateOf(new Date());

export async function createDraft(db: Database, doctorId: string, consultationId: string, ctx: AuditContext): Promise<string> {
  return db.transaction(async (tx) => {
    const c = await tx.query<{ doctor_user_id: string; consent_status: boolean }>(
      `SELECT c.doctor_user_id, pp.consent_status FROM consultations c
         JOIN patient_profiles pp ON pp.user_id = c.patient_user_id WHERE c.id = $1`,
      [consultationId],
    );
    const row = c.rows[0];
    if (!row || row.doctor_user_id !== doctorId) throw notFound('Consultation not found');
    if (!row.consent_status) throw CONSENT_WITHDRAWN();
    const created = await tx.query<{ id: string }>(
      `INSERT INTO prescriptions (consultation_id, patient_user_id, doctor_user_id)
       SELECT id, patient_user_id, doctor_user_id FROM consultations WHERE id = $1 RETURNING id`,
      [consultationId],
    );
    const id = created.rows[0]!.id;
    await audit(tx, ctx, { action: 'PRESCRIPTION_DRAFTED', entityType: 'prescription', entityId: id, after: { consultationId } });
    return id;
  }).then((id) => id);
}

async function medicineFor(db: Queryable, medicineId: string) {
  const r = await db.query<{ id: string; sku: string; name: string; strength: string | null; allergy_class: string | null }>(
    'SELECT id, sku, name, strength, allergy_class FROM medicines WHERE id = $1 AND active',
    [medicineId],
  );
  const m = r.rows[0];
  if (!m) throw new AppError(422, 'INVALID_MEDICINE', 'This medicine is not available in the catalogue');
  return m;
}

function assertDraft(rx: RxRow): void {
  if (rx.status !== 'DRAFT') {
    throw new AppError(409, 'PRESCRIPTION_LOCKED', 'Issued prescriptions cannot be changed. Create a replacement instead.');
  }
}

export async function addItem(db: Database, doctorId: string, rxId: string, input: ItemCreate, ctx: AuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    const rx = await rxForDoctor(tx, doctorId, rxId, true);
    assertDraft(rx);
    const med = await medicineFor(tx, input.medicineId);
    const count = await tx.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM prescription_items WHERE prescription_id = $1', [rxId]);
    if ((count.rows[0]?.n ?? 0) >= MAX_ITEMS) throw new AppError(422, 'TOO_MANY_ITEMS', `A prescription can hold at most ${MAX_ITEMS} medicines`);
    try {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO prescription_items (prescription_id, line_no, medicine_id, medicine_name_snapshot, strength_snapshot,
           allergy_class_snapshot, dose, frequency, duration_days, instructions, quantity)
         VALUES ($1, (SELECT COALESCE(MAX(line_no), 0) + 1 FROM prescription_items WHERE prescription_id = $1),
           $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [rxId, med.id, med.name, med.strength, med.allergy_class, input.dose, input.frequency, input.durationDays, input.instructions ?? null, input.quantity],
      );
      await audit(tx, ctx, { action: 'PRESCRIPTION_ITEM_ADDED', entityType: 'prescription', entityId: rxId, after: { itemId: r.rows[0]!.id, sku: med.sku } });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'DUPLICATE_MEDICINE', 'This medicine is already on the prescription. Change its quantity instead.');
      }
      throw err;
    }
  });
}

export async function updateItem(db: Database, doctorId: string, rxId: string, itemId: string, input: ItemUpdate, ctx: AuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    const rx = await rxForDoctor(tx, doctorId, rxId, true);
    assertDraft(rx);
    const exists = await tx.query('SELECT 1 FROM prescription_items WHERE id = $1 AND prescription_id = $2', [itemId, rxId]);
    if (!exists.rowCount) throw notFound('Medicine line not found');
    const med = input.medicineId ? await medicineFor(tx, input.medicineId) : null;
    await tx.query(
      `UPDATE prescription_items SET
         medicine_id = COALESCE($3::uuid, medicine_id),
         medicine_name_snapshot = COALESCE($4::text, medicine_name_snapshot),
         strength_snapshot = CASE WHEN $3::uuid IS NULL THEN strength_snapshot ELSE $5::text END,
         allergy_class_snapshot = CASE WHEN $3::uuid IS NULL THEN allergy_class_snapshot ELSE $6::text END,
         dose = COALESCE($7::text, dose),
         frequency = COALESCE($8::text, frequency),
         duration_days = COALESCE($9::int, duration_days),
         instructions = CASE WHEN $10::boolean THEN $11::text ELSE instructions END,
         quantity = COALESCE($12::int, quantity)
       WHERE id = $1 AND prescription_id = $2`,
      [
        itemId, rxId, med?.id ?? null, med?.name ?? null, med?.strength ?? null, med?.allergy_class ?? null,
        input.dose ?? null, input.frequency ?? null, input.durationDays ?? null,
        input.instructions !== undefined, input.instructions ?? null, input.quantity ?? null,
      ],
    );
    await audit(tx, ctx, { action: 'PRESCRIPTION_ITEM_UPDATED', entityType: 'prescription', entityId: rxId, after: { itemId } });
  });
}

export async function removeItem(db: Database, doctorId: string, rxId: string, itemId: string, ctx: AuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    const rx = await rxForDoctor(tx, doctorId, rxId, true);
    assertDraft(rx);
    const r = await tx.query('DELETE FROM prescription_items WHERE id = $1 AND prescription_id = $2', [itemId, rxId]);
    if (!r.rowCount) throw notFound('Medicine line not found');
    await audit(tx, ctx, { action: 'PRESCRIPTION_ITEM_REMOVED', entityType: 'prescription', entityId: rxId, after: { itemId } });
  });
}

/**
 * Draft header: advice and validity. 90 days is allowed only when every medicine is marked chronic-eligible
 * by an admin. Until a medicine is marked, 90 days is refused. Nothing is inferred.
 */
export async function updateHeader(
  db: Database,
  doctorId: string,
  rxId: string,
  input: { advice?: string | null; validityDays?: 30 | 90 },
  ctx: AuditContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    const rx = await rxForDoctor(tx, doctorId, rxId, true);
    assertDraft(rx);
    if (input.validityDays === 90) {
      const ids = (await itemsOf(tx, rxId)).map((i) => i.medicine_id);
      const bad = await chronicIneligible(tx, ids);
      if (bad.length) {
        throw new AppError(422, 'NOT_CHRONIC_ELIGIBLE', '90-day validity needs chronic-eligible medicines only', bad.map((b) => ({ path: `items.${b.name}`, message: 'Not marked chronic-eligible' })));
      }
    }
    if (input.advice !== undefined) await tx.query('UPDATE prescriptions SET advice = $2 WHERE id = $1', [rxId, input.advice]);
    if (input.validityDays !== undefined) await tx.query('UPDATE prescriptions SET validity_days = $2 WHERE id = $1', [rxId, input.validityDays]);
    await audit(tx, ctx, { action: 'PRESCRIPTION_HEADER_UPDATED', entityType: 'prescription', entityId: rxId, after: { changed: Object.keys(input) } });
  });
}

/**
 * Issues a draft. Refuses unless the consultation is finalized, there is at least one medicine, and no
 * medicine matches a recorded allergy. A blocked attempt is audited; the refusal is raised after commit,
 * so the audit row survives.
 */
export async function issuePrescription(db: Database, doctorId: string, rxId: string, ctx: AuditContext, now: Date = new Date()): Promise<PrescriptionView> {
  const outcome = await db.transaction(async (tx) => {
    const rx = await rxForDoctor(tx, doctorId, rxId, true);
    if (rx.status !== 'DRAFT') throw new AppError(409, 'ALREADY_ISSUED', 'This prescription has already been issued');
    if (rx.consultation_status !== 'FINALIZED') {
      throw new AppError(422, 'CONSULTATION_NOT_FINALIZED', 'Finalize the consultation before issuing its prescription');
    }
    const items = await itemsOf(tx, rxId);
    if (items.length === 0) throw new AppError(422, 'NO_ITEMS', 'Add at least one medicine before issuing');

    const matches = matchAllergies(
      items.map((i) => ({ sku: i.sku, name: i.medicine_name, allergyClass: i.allergy_class })),
      await activeAllergies(tx, rx.patient_user_id),
    );
    const checkedAt = now.toISOString();
    if (matches.length > 0 && ALLERGY_POLICY === 'BLOCK') {
      await audit(tx, ctx, {
        action: 'PRESCRIPTION_ALLERGY_BLOCKED',
        entityType: 'prescription',
        entityId: rxId,
        after: { policy: ALLERGY_POLICY, matches: matches.map((m) => ({ sku: m.medicineSku, allergyClass: m.allergyClass })) },
      });
      return { blocked: matches, interactionBlocked: null };
    }

    const medicineIds = items.map((i) => i.medicine_id);
    const interactions = await interactionsAmong(tx, medicineIds);
    const majors = interactions.filter((i) => i.severity === 'MAJOR');
    if (majors.length > 0) {
      await audit(tx, ctx, { action: 'PRESCRIPTION_INTERACTION_BLOCKED', entityType: 'prescription', entityId: rxId, after: { majorRules: majors.length } });
      return { blocked: null, interactionBlocked: majors };
    }
    if (rx.validity_days === 90) {
      const notEligible = await chronicIneligible(tx, medicineIds);
      if (notEligible.length) {
        throw new AppError(422, 'NOT_CHRONIC_ELIGIBLE', '90-day validity needs chronic-eligible medicines only', notEligible.map((b) => ({ path: `items.${b.name}`, message: 'Not marked chronic-eligible' })));
      }
    }
    const validTill = addDays(istDateOf(now), rx.validity_days);

    const seq = await tx.query<{ n: string }>(`SELECT nextval('prescription_number_seq')::text AS n`);
    const issueDay = istDateOf(now);
    const rxNumber = formatRxNumber(Number(seq.rows[0]!.n), issueDay.slice(0, 4));
    if (rx.replaces_prescription_id) {
      const sup = await tx.query(
        `UPDATE prescriptions SET status = 'SUPERSEDED', superseded_by_id = $2 WHERE id = $1 AND status = 'ISSUED'`,
        [rx.replaces_prescription_id, rxId],
      );
      if (!sup.rowCount) throw new AppError(409, 'REPLACEMENT_CONFLICT', 'The original prescription is no longer active');
    }
    await tx.query(
      `UPDATE prescriptions SET status = 'ISSUED', rx_number = $2, issued_at = $3, issued_by = $4,
              valid_till = $5::date, allergy_check = $6::jsonb, interaction_check = $7::jsonb WHERE id = $1`,
      [
        rxId, rxNumber, checkedAt, doctorId, validTill,
        JSON.stringify({ policy: ALLERGY_POLICY, matches: [], checkedAt }),
        JSON.stringify({ checkedAt, rules: interactions }),
      ],
    );
    await audit(tx, ctx, {
      action: 'PRESCRIPTION_ISSUED',
      entityType: 'prescription',
      entityId: rxId,
      after: { rxNumber, items: items.length, validTill, validityDays: rx.validity_days },
    });
    return { blocked: null, interactionBlocked: null };
  });

  if (outcome.interactionBlocked) {
    throw new AppError(
      422,
      'INTERACTION_BLOCKED',
      'A major drug interaction on this prescription blocks issuing it. Remove one of the medicines.',
      outcome.interactionBlocked.map((r) => ({ path: 'items', message: `${r.medicines.map((m) => m.name).join(' + ')}: ${r.effect}` })),
    );
  }
  if (outcome.blocked) {
    throw new AppError(
      422,
      'ALLERGY_CONFLICT',
      'A medicine on this prescription matches a recorded allergy. It cannot be issued.',
      outcome.blocked.map((m) => ({ path: `items.${m.medicineSku}`, message: `${m.medicineName} (class ${m.allergyClass}) matches a recorded allergy` })),
    );
  }
  return buildView(db, rxId, todayIst());
}

/** A correction: a new draft that copies the issued prescription. The original is superseded only when the replacement is issued. */
export async function createReplacement(db: Database, doctorId: string, rxId: string, ctx: AuditContext): Promise<string> {
  const newId = await db.transaction(async (tx) => {
    const rx = await rxForDoctor(tx, doctorId, rxId, true);
    if (rx.status !== 'ISSUED') throw new AppError(409, 'NOT_REPLACEABLE', 'Only an issued prescription can be replaced');
    let id: string;
    try {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO prescriptions (consultation_id, patient_user_id, doctor_user_id, replaces_prescription_id, advice)
         SELECT consultation_id, patient_user_id, doctor_user_id, id, advice FROM prescriptions WHERE id = $1
         RETURNING id`,
        [rxId],
      );
      id = r.rows[0]!.id;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'REPLACEMENT_EXISTS', 'A replacement for this prescription already exists');
      }
      throw err;
    }
    await tx.query(
      `INSERT INTO prescription_items (prescription_id, line_no, medicine_id, medicine_name_snapshot, strength_snapshot,
         allergy_class_snapshot, dose, frequency, duration_days, instructions, quantity)
       SELECT $1, line_no, medicine_id, medicine_name_snapshot, strength_snapshot, allergy_class_snapshot, dose,
              frequency, duration_days, instructions, quantity
         FROM prescription_items WHERE prescription_id = $2`,
      [id, rxId],
    );
    await audit(tx, ctx, { action: 'PRESCRIPTION_REPLACEMENT_DRAFTED', entityType: 'prescription', entityId: id, after: { replaces: rxId } });
    return id;
  });
  return newId;
}

/**
 * Marks an issued prescription fulfilled, inside the caller's transaction (the pharmacy packs and deducts
 * stock in the same commit). Only a live issued prescription qualifies, and only once.
 */
export async function fulfilInTx(tx: Queryable, rxId: string, ctx: AuditContext, now: Date = new Date()): Promise<void> {
  const r = await tx.query<{ status: StoredStatus; valid_till: string | null }>(
    `SELECT status, to_char(valid_till, 'YYYY-MM-DD') AS valid_till FROM prescriptions WHERE id = $1 FOR UPDATE`,
    [rxId],
  );
  const row = r.rows[0];
  if (!row) throw notFound('Prescription not found');
  assertDispensable(row.status, row.valid_till, istDateOf(now));
  await tx.query(`UPDATE prescriptions SET status = 'FULFILLED', fulfilled_at = $2 WHERE id = $1`, [rxId, now.toISOString()]);
  await audit(tx, ctx, { action: 'PRESCRIPTION_FULFILLED', entityType: 'prescription', entityId: rxId });
}

/** Standalone form of fulfilInTx, kept for callers outside a pharmacy transaction. */
export async function markFulfilled(db: Database, rxId: string, ctx: AuditContext, now: Date = new Date()): Promise<void> {
  await db.transaction((tx) => fulfilInTx(tx, rxId, ctx, now));
}

/** Re-runs the allergy and major-interaction checks at dispensing time. Allergies can change after issue. */
export async function dispensingChecks(db: Queryable, rxId: string): Promise<{ allergyMatches: AllergyMatch[]; majorInteractions: InteractionView[] }> {
  const h = (await db.query<{ patient_user_id: string }>('SELECT patient_user_id FROM prescriptions WHERE id = $1', [rxId])).rows[0];
  if (!h) throw notFound('Prescription not found');
  const items = await itemsOf(db, rxId);
  const allergyMatches = matchAllergies(
    items.map((i) => ({ sku: i.sku, name: i.medicine_name, allergyClass: i.allergy_class })),
    await activeAllergies(db, h.patient_user_id),
  );
  const majorInteractions = (await interactionsAmong(db, items.map((i) => i.medicine_id))).filter((i) => i.severity === 'MAJOR');
  return { allergyMatches, majorInteractions };
}

export async function getForDoctor(db: Queryable, doctorId: string, rxId: string): Promise<PrescriptionView> {
  await rxForDoctor(db, doctorId, rxId, false);
  return buildView(db, rxId, todayIst());
}

export async function listForConsultation(db: Queryable, doctorId: string, consultationId: string): Promise<PrescriptionView[]> {
  const c = await db.query<{ doctor_user_id: string; consent_status: boolean }>(
    `SELECT c.doctor_user_id, pp.consent_status FROM consultations c
       JOIN patient_profiles pp ON pp.user_id = c.patient_user_id WHERE c.id = $1`,
    [consultationId],
  );
  const row = c.rows[0];
  if (!row || row.doctor_user_id !== doctorId) throw notFound('Consultation not found');
  if (!row.consent_status) throw CONSENT_WITHDRAWN();
  const ids = await db.query<{ id: string }>('SELECT id FROM prescriptions WHERE consultation_id = $1 ORDER BY created_at', [consultationId]);
  const today = todayIst();
  return Promise.all(ids.rows.map((r) => buildView(db, r.id, today)));
}

/** Patients never see drafts; a draft is reported as not found. */
export async function getForPatient(db: Queryable, patientId: string, rxId: string, now: Date = new Date()): Promise<PrescriptionView> {
  const r = await db.query<{ patient_user_id: string; status: StoredStatus }>('SELECT patient_user_id, status FROM prescriptions WHERE id = $1', [rxId]);
  const row = r.rows[0];
  if (!row || row.patient_user_id !== patientId || row.status === 'DRAFT') throw notFound('Prescription not found');
  return buildView(db, rxId, istDateOf(now));
}

export interface PrescriptionSummary {
  id: string;
  rxNumber: string | null;
  status: EffectiveStatus;
  issuedAt: string | null;
  validTill: string | null;
  doctor: { name: string; specialty: string };
  itemCount: number;
}

export async function listForPatient(db: Queryable, patientId: string, q: PageQuery, now: Date = new Date()) {
  const w = pageWindow(q);
  const where = `WHERE p.patient_user_id = $1 AND p.status <> 'DRAFT'`;
  const [rows, count] = await Promise.all([
    db.query<{ id: string; rx_number: string | null; status: StoredStatus; issued_at: Date | null; valid_till: string | null; doctor_name: string; specialty: string; item_count: number }>(
      `SELECT p.id, p.rx_number, p.status, p.issued_at, to_char(p.valid_till, 'YYYY-MM-DD') AS valid_till,
              d.display_name AS doctor_name, d.specialty,
              (SELECT COUNT(*)::int FROM prescription_items pi WHERE pi.prescription_id = p.id) AS item_count
         FROM prescriptions p JOIN doctor_profiles d ON d.user_id = p.doctor_user_id
         ${where} ORDER BY p.issued_at DESC NULLS LAST LIMIT $2 OFFSET $3`,
      [patientId, w.limit, w.offset],
    ),
    db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM prescriptions p ${where}`, [patientId]),
  ]);
  const today = istDateOf(now);
  const items: PrescriptionSummary[] = rows.rows.map((r) => ({
    id: r.id,
    rxNumber: r.rx_number,
    status: effectiveStatus(r.status, r.valid_till, today),
    issuedAt: r.issued_at ? r.issued_at.toISOString() : null,
    validTill: r.valid_till,
    doctor: { name: r.doctor_name, specialty: r.specialty },
    itemCount: r.item_count,
  }));
  return { items, total: count.rows[0]?.n ?? 0 };
}

export async function searchMedicines(db: Queryable, query: string | undefined, q: PageQuery) {
  const pattern = query ? `%${query.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const where = `FROM medicines WHERE active AND ($1::text IS NULL OR name ILIKE $1 OR sku ILIKE $1)`;
  const w = pageWindow(q);
  const [rows, count] = await Promise.all([
    db.query<{ id: string; sku: string; name: string; strength: string | null; form: string; pack_size: string; price_inr: string; rx_required: boolean; allergy_class: string | null }>(
      `SELECT id, sku, name, strength, form, pack_size, price_inr, rx_required, allergy_class ${where}
       ORDER BY name LIMIT $2 OFFSET $3`,
      [pattern, w.limit, w.offset],
    ),
    db.query<{ n: number }>(`SELECT COUNT(*)::int AS n ${where}`, [pattern]),
  ]);
  return {
    items: rows.rows.map((m) => ({
      id: m.id,
      sku: m.sku,
      name: m.name,
      strength: m.strength,
      form: m.form,
      packSize: m.pack_size,
      priceInr: Number(m.price_inr),
      rxRequired: m.rx_required,
      allergyClass: m.allergy_class,
    })),
    total: count.rows[0]?.n ?? 0,
  };
}
