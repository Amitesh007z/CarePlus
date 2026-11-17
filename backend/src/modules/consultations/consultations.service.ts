import { audit, type AuditContext } from '../../common/audit.js';
import { AppError, notFound } from '../../common/errors/AppError.js';
import { pageWindow, type PageQuery } from '../../common/http.js';
import type { Database, Queryable } from '../../infrastructure/database/pool.js';
import { canTransition, type AppointmentStatus } from '../appointments/policy.js';
import type { ConsultationDraft } from './consultations.schemas.js';

const OPEN_WINDOW_MS = 15 * 60_000;

/** Care relationship and consent are checked together on every doctor request. */
export const CONSENT_WITHDRAWN = () =>
  new AppError(403, 'CONSENT_WITHDRAWN', 'This patient has withdrawn consent to share health information');

export interface AddendumView {
  id: string;
  content: string;
  createdAt: string;
}

export interface ConsultationView {
  id: string;
  status: 'DRAFT' | 'FINALIZED';
  appointmentId: string;
  patient: { id: string; name: string };
  doctor: { id: string; name: string; specialty: string };
  slotStartsAt: string;
  chiefComplaint: string | null;
  examinationNotes: string | null;
  diagnosis: { description: string | null; coded: false };
  severity: 'MILD' | 'MODERATE' | 'SEVERE' | null;
  followUpOn: string | null;
  finalizedAt: string | null;
  vitals: { bpSystolic: number | null; bpDiastolic: number | null; pulse: number | null; temperatureC: number | null; spo2: number | null } | null;
  addenda: AddendumView[];
}

/** Compact item for history lists. Examination notes are left out of lists and shown on the detail view. */
export interface VisitSummary {
  id: string;
  finalizedAt: string;
  doctor: { name: string; specialty: string };
  chiefComplaint: string;
  diagnosis: { description: string; coded: false };
  severity: 'MILD' | 'MODERATE' | 'SEVERE';
  followUpOn: string | null;
  vitals: ConsultationView['vitals'];
  addenda: AddendumView[];
}

interface Addendum {
  id: string;
  content: string;
  createdAt: string;
}

interface Row {
  id: string;
  status: 'DRAFT' | 'FINALIZED';
  appointment_id: string;
  patient_user_id: string;
  patient_name: string;
  doctor_user_id: string;
  doctor_name: string;
  specialty: string;
  starts_at: Date;
  chief_complaint: string | null;
  examination_notes: string | null;
  diagnosis_description: string | null;
  severity: 'MILD' | 'MODERATE' | 'SEVERE' | null;
  follow_up_on: string | null;
  finalized_at: Date | null;
  bp_systolic: number | null;
  bp_diastolic: number | null;
  pulse: number | null;
  temperature_c: string | null;
  spo2: number | null;
  addenda: Addendum[];
}

// ADDENDA_JSON needs the consultation alias `c` in scope.
const ADDENDA_JSON = `COALESCE((SELECT json_agg(json_build_object('id', ad.id, 'content', ad.content, 'createdAt', ad.created_at)
  ORDER BY ad.created_at) FROM consultation_addenda ad WHERE ad.consultation_id = c.id), '[]'::json) AS addenda`;

const CONS_SELECT = `SELECT c.id, c.status, c.appointment_id, c.patient_user_id, p.full_name AS patient_name,
  c.doctor_user_id, d.display_name AS doctor_name, d.specialty, s.starts_at, c.chief_complaint, c.examination_notes,
  c.diagnosis_description, c.severity, to_char(c.follow_up_on, 'YYYY-MM-DD') AS follow_up_on, c.finalized_at,
  v.bp_systolic, v.bp_diastolic, v.pulse, v.temperature_c, v.spo2, ${ADDENDA_JSON}
  FROM consultations c
  JOIN appointments a ON a.id = c.appointment_id
  JOIN appointment_slots s ON s.id = a.slot_id
  JOIN patient_profiles p ON p.user_id = c.patient_user_id
  JOIN doctor_profiles d ON d.user_id = c.doctor_user_id
  LEFT JOIN vitals v ON v.consultation_id = c.id`;

function vitalsOf(r: Row): ConsultationView['vitals'] {
  const values = [r.bp_systolic, r.bp_diastolic, r.pulse, r.temperature_c, r.spo2];
  if (values.every((v) => v === null)) return null;
  return {
    bpSystolic: r.bp_systolic,
    bpDiastolic: r.bp_diastolic,
    pulse: r.pulse,
    temperatureC: r.temperature_c === null ? null : Number(r.temperature_c),
    spo2: r.spo2,
  };
}

function toView(r: Row): ConsultationView {
  return {
    id: r.id,
    status: r.status,
    appointmentId: r.appointment_id,
    patient: { id: r.patient_user_id, name: r.patient_name },
    doctor: { id: r.doctor_user_id, name: r.doctor_name, specialty: r.specialty },
    slotStartsAt: r.starts_at.toISOString(),
    chiefComplaint: r.chief_complaint,
    examinationNotes: r.examination_notes,
    diagnosis: { description: r.diagnosis_description, coded: false },
    severity: r.severity,
    followUpOn: r.follow_up_on,
    finalizedAt: r.finalized_at ? r.finalized_at.toISOString() : null,
    vitals: vitalsOf(r),
    addenda: r.addenda,
  };
}

async function loadConsultation(db: Queryable, id: string): Promise<ConsultationView> {
  const r = await db.query<Row>(`${CONS_SELECT} WHERE c.id = $1`, [id]);
  const row = r.rows[0];
  if (!row) throw notFound('Consultation not found');
  return toView(row);
}

interface Access {
  status: 'DRAFT' | 'FINALIZED';
  appointment_id: string;
  chief_complaint: string | null;
  diagnosis_description: string | null;
  severity: string | null;
}

/**
 * Every doctor request passes through here: the consultation must belong to this doctor, and the
 * patient must still consent. `lock` takes a row lock for writes, so concurrent edits serialise.
 */
async function accessFor(db: Queryable, doctorId: string, id: string, lock: boolean): Promise<Access> {
  const r = await db.query<Access & { doctor_user_id: string; consent_status: boolean }>(
    `SELECT c.status, c.appointment_id, c.doctor_user_id, c.chief_complaint, c.diagnosis_description, c.severity,
            p.consent_status
       FROM consultations c JOIN patient_profiles p ON p.user_id = c.patient_user_id
      WHERE c.id = $1 ${lock ? 'FOR UPDATE OF c' : ''}`,
    [id],
  );
  const row = r.rows[0];
  // A consultation that belongs to someone else is reported as not found.
  if (!row || row.doctor_user_id !== doctorId) throw notFound('Consultation not found');
  if (!row.consent_status) throw CONSENT_WITHDRAWN();
  return row;
}

export async function hasCareRelationship(db: Queryable, doctorId: string, patientId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM appointments WHERE doctor_user_id = $1 AND patient_user_id = $2
       AND status IN ('REQUESTED', 'CONFIRMED', 'COMPLETED') LIMIT 1`,
    [doctorId, patientId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function consultationForAppointment(db: Queryable, appointmentId: string): Promise<{ id: string; status: string } | null> {
  const r = await db.query<{ id: string; status: string }>('SELECT id, status FROM consultations WHERE appointment_id = $1', [appointmentId]);
  return r.rows[0] ?? null;
}

/** Opens a draft for a confirmed appointment. Idempotent: returns the existing consultation if there is one. */
export async function openConsultation(
  db: Database,
  doctorId: string,
  appointmentId: string,
  ctx: AuditContext,
  now: Date = new Date(),
): Promise<{ view: ConsultationView; created: boolean }> {
  const result = await db.transaction(async (tx) => {
    const a = await tx.query<{ doctor_user_id: string; status: AppointmentStatus; starts_at: Date; consent_status: boolean }>(
      `SELECT a.doctor_user_id, a.status, s.starts_at, p.consent_status
         FROM appointments a
         JOIN appointment_slots s ON s.id = a.slot_id
         JOIN patient_profiles p ON p.user_id = a.patient_user_id
        WHERE a.id = $1 FOR UPDATE OF a`,
      [appointmentId],
    );
    const appt = a.rows[0];
    if (!appt || appt.doctor_user_id !== doctorId) throw notFound('Appointment not found');
    if (!appt.consent_status) throw CONSENT_WITHDRAWN();

    const existing = await tx.query<{ id: string }>('SELECT id FROM consultations WHERE appointment_id = $1', [appointmentId]);
    if (existing.rows[0]) return { id: existing.rows[0].id, created: false };

    if (appt.status !== 'CONFIRMED') {
      throw new AppError(409, 'INVALID_STATE', 'Confirm the appointment before starting its consultation');
    }
    if (appt.starts_at.getTime() - now.getTime() > OPEN_WINDOW_MS) {
      throw new AppError(422, 'TOO_EARLY', 'The consultation opens 15 minutes before the slot');
    }
    const created = await tx.query<{ id: string }>(
      `INSERT INTO consultations (appointment_id, patient_user_id, doctor_user_id)
       SELECT id, patient_user_id, doctor_user_id FROM appointments WHERE id = $1
       RETURNING id`,
      [appointmentId],
    );
    const id = created.rows[0]!.id;
    await audit(tx, ctx, { action: 'CONSULTATION_OPENED', entityType: 'consultation', entityId: id, after: { appointmentId } });
    return { id, created: true };
  });
  return { view: await loadConsultation(db, result.id), created: result.created };
}

export async function getConsultationForDoctor(db: Queryable, doctorId: string, id: string): Promise<ConsultationView> {
  await accessFor(db, doctorId, id, false);
  return loadConsultation(db, id);
}

/** Saves the draft as a full replacement. Refused once finalized, so finalized content is never silently edited. */
export async function saveDraft(db: Database, doctorId: string, id: string, input: ConsultationDraft, ctx: AuditContext): Promise<ConsultationView> {
  await db.transaction(async (tx) => {
    const access = await accessFor(tx, doctorId, id, true);
    if (access.status !== 'DRAFT') {
      throw new AppError(409, 'CONSULTATION_FINALIZED', 'Finalized consultations cannot be edited. Add an addendum instead.');
    }
    await tx.query(
      `UPDATE consultations SET chief_complaint = $2, examination_notes = $3, diagnosis_description = $4,
              severity = $5, follow_up_on = $6::date
        WHERE id = $1`,
      [id, input.chiefComplaint, input.examinationNotes, input.diagnosisDescription, input.severity, input.followUpOn],
    );
    if (input.vitals === null) {
      await tx.query('DELETE FROM vitals WHERE consultation_id = $1', [id]);
    } else {
      const v = input.vitals;
      await tx.query(
        `INSERT INTO vitals (consultation_id, bp_systolic, bp_diastolic, pulse, temperature_c, spo2)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (consultation_id) DO UPDATE SET bp_systolic = EXCLUDED.bp_systolic,
           bp_diastolic = EXCLUDED.bp_diastolic, pulse = EXCLUDED.pulse,
           temperature_c = EXCLUDED.temperature_c, spo2 = EXCLUDED.spo2, recorded_at = now()`,
        [id, v.bpSystolic, v.bpDiastolic, v.pulse, v.temperatureC, v.spo2],
      );
    }
    // Audit records which fields changed, never their clinical values.
    await audit(tx, ctx, { action: 'CONSULTATION_DRAFT_SAVED', entityType: 'consultation', entityId: id, after: { fields: Object.keys(input) } });
  });
  return loadConsultation(db, id);
}

/** Finalizes a draft and marks the appointment completed. Finalized records cannot change afterwards. */
export async function finalizeConsultation(db: Database, doctorId: string, id: string, ctx: AuditContext): Promise<ConsultationView> {
  await db.transaction(async (tx) => {
    const access = await accessFor(tx, doctorId, id, true);
    if (access.status !== 'DRAFT') throw new AppError(409, 'ALREADY_FINALIZED', 'This consultation is already finalized');

    const missing: { path: string; message: string }[] = [];
    if (!access.chief_complaint) missing.push({ path: 'chiefComplaint', message: 'Required before finalizing' });
    if (!access.diagnosis_description) missing.push({ path: 'diagnosis.description', message: 'Required before finalizing' });
    if (!access.severity) missing.push({ path: 'severity', message: 'Required before finalizing' });
    if (missing.length) throw new AppError(422, 'INCOMPLETE', 'Complete the required fields before finalizing', missing);

    await tx.query(
      `UPDATE consultations SET status = 'FINALIZED', finalized_at = now(), finalized_by = $2 WHERE id = $1`,
      [id, doctorId],
    );
    const appt = await tx.query<{ status: AppointmentStatus }>('SELECT status FROM appointments WHERE id = $1 FOR UPDATE', [access.appointment_id]);
    const status = appt.rows[0]?.status;
    if (status !== 'COMPLETED') {
      if (!status || !canTransition(status, 'COMPLETED')) {
        throw new AppError(409, 'INVALID_TRANSITION', 'The appointment cannot be completed from its current state');
      }
      await tx.query(`UPDATE appointments SET status = 'COMPLETED' WHERE id = $1`, [access.appointment_id]);
    }
    await audit(tx, ctx, { action: 'CONSULTATION_FINALIZED', entityType: 'consultation', entityId: id, after: { status: 'FINALIZED' } });
  });
  return loadConsultation(db, id);
}

/** Corrections to a finalized record. The original content is never touched. */
export async function addAddendum(db: Database, doctorId: string, id: string, content: string, ctx: AuditContext): Promise<ConsultationView> {
  await db.transaction(async (tx) => {
    const access = await accessFor(tx, doctorId, id, true);
    if (access.status !== 'FINALIZED') {
      throw new AppError(409, 'NOT_FINALIZED', 'Addenda correct finalized consultations. Edit the draft instead.');
    }
    const r = await tx.query<{ id: string }>(
      'INSERT INTO consultation_addenda (consultation_id, author_user_id, content) VALUES ($1, $2, $3) RETURNING id',
      [id, doctorId, content],
    );
    // The audit row records that an addendum exists, not its text.
    await audit(tx, ctx, { action: 'CONSULTATION_ADDENDUM_ADDED', entityType: 'consultation', entityId: id, after: { addendumId: r.rows[0]!.id } });
  });
  return loadConsultation(db, id);
}

const VISIT_FROM = `FROM consultations c
  JOIN appointments a ON a.id = c.appointment_id
  JOIN appointment_slots s ON s.id = a.slot_id
  JOIN doctor_profiles d ON d.user_id = c.doctor_user_id
  LEFT JOIN vitals v ON v.consultation_id = c.id
  WHERE c.status = 'FINALIZED' AND c.patient_user_id = $1`;

/** Finalized visits for one patient, newest first. Drafts are never listed. */
async function listVisits(db: Queryable, patientId: string, q: PageQuery): Promise<{ items: VisitSummary[]; total: number }> {
  const w = pageWindow(q);
  const [rows, count] = await Promise.all([
    db.query<Row & { finalized_at: Date }>(
      `SELECT c.id, c.finalized_at, c.chief_complaint, c.diagnosis_description, c.severity,
              to_char(c.follow_up_on, 'YYYY-MM-DD') AS follow_up_on, v.bp_systolic, v.bp_diastolic, v.pulse,
              v.temperature_c, v.spo2, d.display_name AS doctor_name, d.specialty, ${ADDENDA_JSON}
         ${VISIT_FROM} ORDER BY c.finalized_at DESC LIMIT $2 OFFSET $3`,
      [patientId, w.limit, w.offset],
    ),
    db.query<{ n: number }>(`SELECT COUNT(*)::int AS n ${VISIT_FROM}`, [patientId]),
  ]);
  return {
    items: rows.rows.map((r) => ({
      id: r.id,
      finalizedAt: r.finalized_at.toISOString(),
      doctor: { name: r.doctor_name, specialty: r.specialty },
      chiefComplaint: r.chief_complaint ?? '',
      diagnosis: { description: r.diagnosis_description ?? '', coded: false as const },
      severity: r.severity ?? 'MILD',
      followUpOn: r.follow_up_on,
      vitals: vitalsOf(r),
      addenda: r.addenda,
    })),
    total: count.rows[0]?.n ?? 0,
  };
}

/** A doctor's view of a patient's history. Requires a care relationship and current consent. */
export async function listPatientHistoryForDoctor(db: Queryable, doctorId: string, patientId: string, q: PageQuery) {
  if (!(await hasCareRelationship(db, doctorId, patientId))) throw notFound('Patient record not found');
  const consent = await db.query<{ consent_status: boolean }>('SELECT consent_status FROM patient_profiles WHERE user_id = $1', [patientId]);
  if (!consent.rows[0]) throw notFound('Patient record not found');
  if (!consent.rows[0].consent_status) throw CONSENT_WITHDRAWN();
  return listVisits(db, patientId, q);
}

export const listVisitsForPatient = (db: Queryable, patientId: string, q: PageQuery) => listVisits(db, patientId, q);
