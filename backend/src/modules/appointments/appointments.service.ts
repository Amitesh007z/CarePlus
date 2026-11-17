import { audit, type AuditContext } from '../../common/audit.js';
import { AppError, notFound } from '../../common/errors/AppError.js';
import { pageWindow, type PageQuery } from '../../common/http.js';
import { istInstant } from '../../common/time.js';
import type { Database, Queryable } from '../../infrastructure/database/pool.js';
import { CONSENT_REQUIRED } from '../patients/patients.service.js';
import type { BookInput } from './appointments.schemas.js';
import {
  BOOKING_FEE_INR,
  canTransition,
  cancellationPolicy,
  OCCUPYING_STATUSES,
  reschedulePermitted,
  type AppointmentStatus,
  type FeeStatus,
} from './policy.js';

export interface AppointmentView {
  id: string;
  status: AppointmentStatus;
  chiefComplaint: string;
  symptoms: string[];
  durationDays: number;
  severity: 'MILD' | 'MODERATE' | 'SEVERE';
  additionalNotes: string | null;
  doctor: { id: string; name: string; specialty: string };
  patient: { id: string; name: string };
  slot: { id: string; startsAt: string; endsAt: string };
  booking: { feeInr: number; feeStatus: FeeStatus };
  cancellation: { at: string; by: string | null; reason: string | null } | null;
  rescheduledCount: number;
  createdAt: string;
}

interface Row {
  id: string;
  status: AppointmentStatus;
  chief_complaint: string;
  symptoms: string[];
  duration_days: number;
  severity: 'MILD' | 'MODERATE' | 'SEVERE';
  additional_notes: string | null;
  booking_fee_inr: string;
  fee_status: FeeStatus;
  cancelled_at: Date | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  rescheduled_count: number;
  created_at: Date;
  patient_user_id: string;
  patient_name: string;
  doctor_user_id: string;
  doctor_name: string;
  specialty: string;
  slot_id: string;
  starts_at: Date;
  ends_at: Date;
}

const OCCUPYING_SQL = `(${OCCUPYING_STATUSES.map((s) => `'${s}'`).join(', ')})`;

const VIEW_COLS = `a.id, a.status, a.chief_complaint, a.symptoms, a.duration_days, a.severity, a.additional_notes,
  a.booking_fee_inr, a.fee_status, a.cancelled_at, a.cancelled_by, a.cancel_reason, a.rescheduled_count, a.created_at,
  a.patient_user_id, p.full_name AS patient_name, a.doctor_user_id, d.display_name AS doctor_name, d.specialty,
  s.id AS slot_id, s.starts_at, s.ends_at`;

const FROM_SQL = `FROM appointments a
  JOIN appointment_slots s ON s.id = a.slot_id
  JOIN doctor_profiles d ON d.user_id = a.doctor_user_id
  JOIN patient_profiles p ON p.user_id = a.patient_user_id`;

function toView(r: Row): AppointmentView {
  return {
    id: r.id,
    status: r.status,
    chiefComplaint: r.chief_complaint,
    symptoms: r.symptoms,
    durationDays: r.duration_days,
    severity: r.severity,
    additionalNotes: r.additional_notes,
    doctor: { id: r.doctor_user_id, name: r.doctor_name, specialty: r.specialty },
    patient: { id: r.patient_user_id, name: r.patient_name },
    slot: { id: r.slot_id, startsAt: r.starts_at.toISOString(), endsAt: r.ends_at.toISOString() },
    booking: { feeInr: Number(r.booking_fee_inr), feeStatus: r.fee_status },
    cancellation: r.cancelled_at
      ? { at: r.cancelled_at.toISOString(), by: r.cancelled_by, reason: r.cancel_reason }
      : null,
    rescheduledCount: r.rescheduled_count,
    createdAt: r.created_at.toISOString(),
  };
}

async function loadView(db: Queryable, id: string): Promise<AppointmentView> {
  const r = await db.query<Row>(`SELECT ${VIEW_COLS} ${FROM_SQL} WHERE a.id = $1`, [id]);
  const row = r.rows[0];
  if (!row) throw notFound('Appointment not found');
  return toView(row);
}

/** Locks the slot row and refuses it if an active booking already holds it. */
async function assertSlotFree(tx: Queryable, slotId: string): Promise<void> {
  const busy = await tx.query(
    `SELECT 1 FROM appointments WHERE slot_id = $1 AND status IN ${OCCUPYING_SQL} LIMIT 1`,
    [slotId],
  );
  if (busy.rowCount) throw new AppError(409, 'SLOT_TAKEN', 'This time slot was just booked. Please choose another.');
}

/** Converts a unique-index violation (23505) into a clean 409; the lock above makes this the rare backstop. */
async function withSlotConflict<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new AppError(409, 'SLOT_TAKEN', 'This time slot was just booked. Please choose another.');
    }
    throw err;
  }
}

interface SlotCheck {
  id: string;
  doctor_user_id: string;
  starts_at: Date;
  status: string;
  doctor_active: boolean;
  consent_status: boolean;
}

export async function bookAppointment(
  db: Database,
  patientId: string,
  input: BookInput,
  ctx: AuditContext,
  now: Date = new Date(),
): Promise<AppointmentView> {
  const id = await db.transaction(async (tx) => {
    // FOR UPDATE serialises concurrent bookings of the same slot: the second caller waits, then sees the first booking.
    const found = await tx.query<SlotCheck>(
      `SELECT s.id, s.doctor_user_id, s.starts_at, s.status, d.active AS doctor_active, p.consent_status
         FROM appointment_slots s
         JOIN doctor_profiles d ON d.user_id = s.doctor_user_id
         JOIN patient_profiles p ON p.user_id = $2
        WHERE s.id = $1
        FOR UPDATE OF s`,
      [input.slotId, patientId],
    );
    const slot = found.rows[0];
    if (!slot) throw notFound('Time slot not found');
    if (!slot.consent_status) throw CONSENT_REQUIRED();
    if (!slot.doctor_active) throw new AppError(422, 'DOCTOR_UNAVAILABLE', 'This doctor is not accepting appointments');
    if (slot.status !== 'OPEN') throw new AppError(422, 'SLOT_UNAVAILABLE', 'This time slot is not available');
    if (slot.starts_at.getTime() <= now.getTime()) {
      throw new AppError(422, 'PAST_SLOT', 'This time slot has already started or passed');
    }
    await assertSlotFree(tx, slot.id);

    const inserted = await withSlotConflict(() =>
      tx.query<{ id: string }>(
        `INSERT INTO appointments (patient_user_id, doctor_user_id, slot_id, status, chief_complaint, symptoms,
           duration_days, severity, additional_notes, booking_fee_inr)
         VALUES ($1, $2, $3, 'REQUESTED', $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          patientId, slot.doctor_user_id, slot.id, input.chiefComplaint, input.symptoms, input.durationDays,
          input.severity, input.additionalNotes ?? null, BOOKING_FEE_INR,
        ],
      ),
    );
    const newId = inserted.rows[0]!.id;
    await audit(tx, ctx, {
      action: 'APPOINTMENT_BOOKED',
      entityType: 'appointment',
      entityId: newId,
      after: { status: 'REQUESTED', slotId: slot.id },
    });
    return newId;
  });
  return loadView(db, id);
}

export async function cancelAppointment(
  db: Database,
  patientId: string,
  appointmentId: string,
  reason: string | null | undefined,
  ctx: AuditContext,
  now: Date = new Date(),
): Promise<AppointmentView> {
  await db.transaction(async (tx) => {
    const r = await tx.query<{ id: string; status: AppointmentStatus; patient_user_id: string; starts_at: Date }>(
      `SELECT a.id, a.status, a.patient_user_id, s.starts_at
         FROM appointments a JOIN appointment_slots s ON s.id = a.slot_id
        WHERE a.id = $1 FOR UPDATE OF a`,
      [appointmentId],
    );
    const row = r.rows[0];
    // Another patient's appointment is reported as not found, so existence is not revealed.
    if (!row || row.patient_user_id !== patientId) throw notFound('Appointment not found');
    if (!canTransition(row.status, 'CANCELLED')) {
      throw new AppError(409, 'INVALID_TRANSITION', `A ${row.status.toLowerCase()} appointment cannot be cancelled`);
    }
    const policy = cancellationPolicy(row.starts_at, now);
    if (!policy.allowed) throw new AppError(422, 'CANCELLATION_CLOSED', 'This appointment time has already passed');

    await tx.query(
      `UPDATE appointments SET status = 'CANCELLED', cancelled_at = $2, cancelled_by = 'PATIENT',
              cancel_reason = $3, fee_status = $4
        WHERE id = $1`,
      [appointmentId, now.toISOString(), reason ?? null, policy.fee],
    );
    await audit(tx, ctx, {
      action: 'APPOINTMENT_CANCELLED',
      entityType: 'appointment',
      entityId: appointmentId,
      before: { status: row.status },
      after: { status: 'CANCELLED', fee: policy.fee },
    });
  });
  return loadView(db, appointmentId);
}

export async function rescheduleAppointment(
  db: Database,
  patientId: string,
  appointmentId: string,
  newSlotId: string,
  ctx: AuditContext,
  now: Date = new Date(),
): Promise<AppointmentView> {
  await db.transaction(async (tx) => {
    const r = await tx.query<{ id: string; status: AppointmentStatus; patient_user_id: string; doctor_user_id: string; slot_id: string; starts_at: Date }>(
      `SELECT a.id, a.status, a.patient_user_id, a.doctor_user_id, a.slot_id, s.starts_at
         FROM appointments a JOIN appointment_slots s ON s.id = a.slot_id
        WHERE a.id = $1 FOR UPDATE OF a`,
      [appointmentId],
    );
    const current = r.rows[0];
    if (!current || current.patient_user_id !== patientId) throw notFound('Appointment not found');
    if (current.status !== 'REQUESTED' && current.status !== 'CONFIRMED') {
      throw new AppError(409, 'INVALID_TRANSITION', `A ${current.status.toLowerCase()} appointment cannot be rescheduled`);
    }
    if (current.starts_at.getTime() <= now.getTime()) throw new AppError(422, 'RESCHEDULE_CLOSED', 'This appointment time has already passed');
    if (!reschedulePermitted(current.starts_at, now)) {
      throw new AppError(422, 'RESCHEDULE_WINDOW_CLOSED', 'Appointments can be rescheduled up to 2 hours before the slot');
    }
    if (newSlotId === current.slot_id) throw new AppError(422, 'SAME_SLOT', 'Choose a different time slot');

    const target = await tx.query<SlotCheck>(
      `SELECT s.id, s.doctor_user_id, s.starts_at, s.status, d.active AS doctor_active, TRUE AS consent_status
         FROM appointment_slots s JOIN doctor_profiles d ON d.user_id = s.doctor_user_id
        WHERE s.id = $1 FOR UPDATE OF s`,
      [newSlotId],
    );
    const slot = target.rows[0];
    if (!slot) throw notFound('Time slot not found');
    if (slot.doctor_user_id !== current.doctor_user_id) {
      throw new AppError(422, 'DIFFERENT_DOCTOR', 'Rescheduling must stay with the same doctor');
    }
    if (!slot.doctor_active) throw new AppError(422, 'DOCTOR_UNAVAILABLE', 'This doctor is not accepting appointments');
    if (slot.status !== 'OPEN') throw new AppError(422, 'SLOT_UNAVAILABLE', 'This time slot is not available');
    if (slot.starts_at.getTime() <= now.getTime()) throw new AppError(422, 'PAST_SLOT', 'This time slot has already started or passed');
    await assertSlotFree(tx, slot.id);

    await withSlotConflict(() =>
      tx.query(
        `UPDATE appointments SET slot_id = $2, rescheduled_count = rescheduled_count + 1 WHERE id = $1`,
        [appointmentId, slot.id],
      ),
    );
    await audit(tx, ctx, {
      action: 'APPOINTMENT_RESCHEDULED',
      entityType: 'appointment',
      entityId: appointmentId,
      before: { slotId: current.slot_id },
      after: { slotId: slot.id },
    });
  });
  return loadView(db, appointmentId);
}

export type PatientScope = 'upcoming' | 'past' | 'all';

const SCOPE_SQL: Record<PatientScope, string> = {
  upcoming: `AND a.status IN ('REQUESTED', 'CONFIRMED') AND s.starts_at >= $2`,
  past: `AND (a.status IN ('COMPLETED', 'CANCELLED') OR s.starts_at < $2)`,
  all: `AND $2::timestamptz IS NOT NULL`,
};

export async function listPatientAppointments(
  db: Queryable,
  patientId: string,
  scope: PatientScope,
  q: PageQuery,
  now: Date = new Date(),
): Promise<{ items: AppointmentView[]; total: number }> {
  const where = `WHERE a.patient_user_id = $1 ${SCOPE_SQL[scope]}`;
  const params = [patientId, now.toISOString()];
  const order = scope === 'past' ? 'DESC' : 'ASC';
  const w = pageWindow(q);
  const [rows, count] = await Promise.all([
    db.query<Row>(
      `SELECT ${VIEW_COLS} ${FROM_SQL} ${where} ORDER BY s.starts_at ${order} LIMIT $3 OFFSET $4`,
      [...params, w.limit, w.offset],
    ),
    db.query<{ n: number }>(`SELECT COUNT(*)::int AS n ${FROM_SQL} ${where}`, params),
  ]);
  return { items: rows.rows.map(toView), total: count.rows[0]?.n ?? 0 };
}

/**
 * A doctor sees only their own appointments. Patients who have withdrawn consent are excluded:
 * withdrawal stops future sharing with doctors, including details of appointments already booked.
 */
export async function listDoctorAppointments(
  db: Queryable,
  doctorId: string,
  q: PageQuery & { from: string; to: string; status?: AppointmentStatus },
): Promise<{ items: AppointmentView[]; total: number }> {
  const where = `WHERE a.doctor_user_id = $1 AND p.consent_status = true
    AND s.starts_at >= $2 AND s.starts_at < $3 AND ($4::text IS NULL OR a.status = $4)`;
  const params = [doctorId, istInstant(q.from, '00:00').toISOString(), istInstant(q.to, '00:00').toISOString(), q.status ?? null];
  const w = pageWindow(q);
  const [rows, count] = await Promise.all([
    db.query<Row>(`SELECT ${VIEW_COLS} ${FROM_SQL} ${where} ORDER BY s.starts_at ASC LIMIT $5 OFFSET $6`, [...params, w.limit, w.offset]),
    db.query<{ n: number }>(`SELECT COUNT(*)::int AS n ${FROM_SQL} ${where}`, params),
  ]);
  return { items: rows.rows.map(toView), total: count.rows[0]?.n ?? 0 };
}

export async function setStatusByDoctor(
  db: Database,
  doctorId: string,
  appointmentId: string,
  to: 'CONFIRMED' | 'COMPLETED',
  ctx: AuditContext,
  now: Date = new Date(),
): Promise<AppointmentView> {
  await db.transaction(async (tx) => {
    const r = await tx.query<{ doctor_user_id: string; status: AppointmentStatus; starts_at: Date }>(
      `SELECT a.doctor_user_id, a.status, s.starts_at
         FROM appointments a JOIN appointment_slots s ON s.id = a.slot_id
        WHERE a.id = $1 FOR UPDATE OF a`,
      [appointmentId],
    );
    const row = r.rows[0];
    if (!row || row.doctor_user_id !== doctorId) throw notFound('Appointment not found');
    if (!canTransition(row.status, to)) {
      throw new AppError(409, 'INVALID_TRANSITION', `Cannot change a ${row.status.toLowerCase()} appointment to ${to.toLowerCase()}`);
    }
    if (to === 'COMPLETED' && row.starts_at.getTime() > now.getTime()) {
      throw new AppError(422, 'TOO_EARLY', 'An appointment can be completed only after its slot starts');
    }
    await tx.query('UPDATE appointments SET status = $2 WHERE id = $1', [appointmentId, to]);
    await audit(tx, ctx, {
      action: 'APPOINTMENT_STATUS_CHANGED',
      entityType: 'appointment',
      entityId: appointmentId,
      before: { status: row.status },
      after: { status: to },
    });
  });
  return loadView(db, appointmentId);
}
