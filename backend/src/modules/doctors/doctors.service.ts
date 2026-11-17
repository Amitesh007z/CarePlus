import { AppError, notFound } from '../../common/errors/AppError.js';
import { pageWindow, type PageQuery } from '../../common/http.js';
import { addDays, istInstant, slotsForDate, type SlotRule } from '../../common/time.js';
import type { Database, Queryable } from '../../infrastructure/database/pool.js';
import { ageFromDob } from '../auth/user.repository.js';

/** Public directory fields only: no registration number, email or mobile. */
export interface DoctorSummary {
  id: string;
  displayName: string;
  specialty: string;
  experienceYears: number;
}

export interface DoctorDetail extends DoctorSummary {
  availability: { weekday: number; startTime: string; endTime: string; slotMinutes: number }[];
}

export interface SlotView {
  id: string;
  startsAt: string;
  endsAt: string;
  booked: boolean;
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);

const ACTIVE_DOCTOR_SQL = `d.active AND u.status = 'ACTIVE'`;

export async function listDoctors(
  db: Queryable,
  q: PageQuery & { query?: string },
): Promise<{ items: DoctorSummary[]; total: number }> {
  const pattern = q.query ? `%${escapeLike(q.query)}%` : null;
  const where = `FROM doctor_profiles d JOIN users u ON u.id = d.user_id
    WHERE ${ACTIVE_DOCTOR_SQL} AND ($1::text IS NULL OR d.display_name ILIKE $1 OR d.specialty ILIKE $1)`;
  const w = pageWindow(q);
  const [rows, count] = await Promise.all([
    db.query<{ id: string; display_name: string; specialty: string; experience_years: number }>(
      `SELECT d.user_id AS id, d.display_name, d.specialty, d.experience_years ${where}
       ORDER BY d.display_name ASC LIMIT $2 OFFSET $3`,
      [pattern, w.limit, w.offset],
    ),
    db.query<{ n: number }>(`SELECT COUNT(*)::int AS n ${where}`, [pattern]),
  ]);
  return {
    items: rows.rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      specialty: r.specialty,
      experienceYears: r.experience_years,
    })),
    total: count.rows[0]?.n ?? 0,
  };
}

export async function getDoctor(db: Queryable, doctorId: string): Promise<DoctorDetail> {
  const r = await db.query<{ id: string; display_name: string; specialty: string; experience_years: number }>(
    `SELECT d.user_id AS id, d.display_name, d.specialty, d.experience_years
       FROM doctor_profiles d JOIN users u ON u.id = d.user_id
      WHERE d.user_id = $1 AND ${ACTIVE_DOCTOR_SQL}`,
    [doctorId],
  );
  const doc = r.rows[0];
  if (!doc) throw notFound('Doctor not found');
  const rules = await loadRules(db, doctorId);
  return {
    id: doc.id,
    displayName: doc.display_name,
    specialty: doc.specialty,
    experienceYears: doc.experience_years,
    availability: rules.map((x) => ({
      weekday: x.weekday,
      startTime: x.startTime.slice(0, 5),
      endTime: x.endTime.slice(0, 5),
      slotMinutes: x.slotMinutes,
    })),
  };
}

async function loadRules(db: Queryable, doctorId: string): Promise<SlotRule[]> {
  const r = await db.query<{ weekday: number; start_time: string; end_time: string; slot_minutes: number }>(
    `SELECT weekday, start_time, end_time, slot_minutes FROM doctor_availability
      WHERE doctor_user_id = $1 AND active ORDER BY weekday, start_time`,
    [doctorId],
  );
  return r.rows.map((x) => ({ weekday: x.weekday, startTime: x.start_time, endTime: x.end_time, slotMinutes: x.slot_minutes }));
}

/**
 * Returns bookable slots for `days` IST dates starting at `from`. Slots are materialised lazily from the
 * weekly rules (ON CONFLICT DO NOTHING, so concurrent callers are safe). Only the requested window is
 * generated, which keeps the table bounded.
 */
export async function listOpenSlots(
  db: Database,
  doctorId: string,
  from: string,
  days: number,
  now: Date = new Date(),
): Promise<SlotView[]> {
  const active = await db.query(
    `SELECT 1 FROM doctor_profiles d JOIN users u ON u.id = d.user_id WHERE d.user_id = $1 AND ${ACTIVE_DOCTOR_SQL}`,
    [doctorId],
  );
  if (!active.rowCount) throw new AppError(404, 'NOT_FOUND', 'Doctor not found');

  const rules = await loadRules(db, doctorId);
  const generated: { startsAt: Date; endsAt: Date }[] = [];
  for (let i = 0; i < days; i++) {
    for (const s of slotsForDate(addDays(from, i), rules)) if (s.startsAt > now) generated.push(s);
  }
  if (generated.length) {
    await db.transaction((tx) =>
      tx.query(
        `INSERT INTO appointment_slots (doctor_user_id, starts_at, ends_at)
         SELECT $1, t.s, t.e FROM unnest($2::timestamptz[], $3::timestamptz[]) AS t(s, e)
         ON CONFLICT (doctor_user_id, starts_at) DO NOTHING`,
        [doctorId, generated.map((g) => g.startsAt.toISOString()), generated.map((g) => g.endsAt.toISOString())],
      ),
    );
  }

  const r = await db.query<{ id: string; starts_at: Date; ends_at: Date; booked: boolean }>(
    `SELECT s.id, s.starts_at, s.ends_at,
            EXISTS (SELECT 1 FROM appointments a
                     WHERE a.slot_id = s.id AND a.status IN ('REQUESTED', 'CONFIRMED', 'COMPLETED')) AS booked
       FROM appointment_slots s
      WHERE s.doctor_user_id = $1 AND s.status = 'OPEN' AND s.starts_at > $2
        AND s.starts_at >= $3 AND s.starts_at < $4
      ORDER BY s.starts_at`,
    [
      doctorId,
      now.toISOString(),
      istInstant(from, '00:00').toISOString(),
      istInstant(addDays(from, days), '00:00').toISOString(),
    ],
  );
  return r.rows.map((x) => ({
    id: x.id,
    startsAt: x.starts_at.toISOString(),
    endsAt: x.ends_at.toISOString(),
    booked: x.booked,
  }));
}

export interface PatientContextForDoctor {
  patient: { fullName: string; age: number; gender: string; bloodGroup: string };
  allergies: { name: string; allergyClass: string | null; severity: string | null; notedOn: string; notes: string | null }[];
  conditions: { name: string; severity: string | null; notedOn: string; notes: string | null }[];
  medications: { medicationName: string; dose: string | null; frequency: string | null; startedOn: string }[];
}

/**
 * Clinical context is shared only when (a) the doctor has a live appointment with this patient and
 * (b) the patient has not withdrawn consent. Address and contact details are never included.
 */
export async function getPatientContextForDoctor(db: Queryable, doctorId: string, patientId: string): Promise<PatientContextForDoctor> {
  const rel = await db.query(
    `SELECT 1 FROM appointments WHERE doctor_user_id = $1 AND patient_user_id = $2
       AND status IN ('REQUESTED', 'CONFIRMED', 'COMPLETED') LIMIT 1`,
    [doctorId, patientId],
  );
  if (!rel.rowCount) throw notFound('Patient record not found');

  const p = await db.query<{ full_name: string; dob: string; gender: string; blood_group: string; consent_status: boolean }>(
    `SELECT full_name, to_char(dob, 'YYYY-MM-DD') AS dob, gender, blood_group, consent_status
       FROM patient_profiles WHERE user_id = $1`,
    [patientId],
  );
  const prof = p.rows[0];
  if (!prof) throw notFound('Patient record not found');
  if (!prof.consent_status) {
    throw new AppError(403, 'CONSENT_WITHDRAWN', 'This patient has withdrawn consent to share health information');
  }

  const health = await db.query<{ type: string; name: string; allergy_class: string | null; severity: string | null; noted_on: string; notes: string | null }>(
    `SELECT type, name, allergy_class, severity, to_char(noted_on, 'YYYY-MM-DD') AS noted_on, notes
       FROM health_info WHERE patient_user_id = $1 AND active ORDER BY type, noted_on DESC`,
    [patientId],
  );
  const meds = await db.query<{ medication_name: string; dose: string | null; frequency: string | null; started_on: string }>(
    `SELECT medication_name, dose, frequency, to_char(started_on, 'YYYY-MM-DD') AS started_on
       FROM patient_medications WHERE patient_user_id = $1 AND active ORDER BY started_on DESC`,
    [patientId],
  );

  return {
    patient: {
      fullName: prof.full_name,
      age: ageFromDob(prof.dob),
      gender: prof.gender,
      bloodGroup: prof.blood_group,
    },
    allergies: health.rows
      .filter((h) => h.type === 'ALLERGY')
      .map((h) => ({ name: h.name, allergyClass: h.allergy_class, severity: h.severity, notedOn: h.noted_on, notes: h.notes })),
    conditions: health.rows
      .filter((h) => h.type === 'CONDITION')
      .map((h) => ({ name: h.name, severity: h.severity, notedOn: h.noted_on, notes: h.notes })),
    medications: meds.rows.map((m) => ({
      medicationName: m.medication_name,
      dose: m.dose,
      frequency: m.frequency,
      startedOn: m.started_on,
    })),
  };
}
