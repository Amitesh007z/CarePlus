import { notFound } from '../../common/errors/AppError.js';
import { ageFromDob } from '../auth/user.repository.js';
import type { Queryable } from '../../infrastructure/database/pool.js';
import { dispensingChecks, effectiveStatus, type StoredStatus } from '../prescriptions/prescriptions.service.js';
import { istDateOf } from '../../common/time.js';

/**
 * What a pharmacist may see of a prescription, and only when it is linked to pharmacy work (an order or a
 * fulfilment request). Diagnosis, advice, consultation notes, vitals and the full allergy list are never included.
 * The allergy outcome is reduced to the names of the medicines that conflict.
 */
export interface PrescriptionReview {
  id: string;
  rxNumber: string | null;
  status: string;
  validTill: string | null;
  issuedAt: string | null;
  patient: { name: string; age: number };
  doctor: { name: string; specialty: string; registrationNo: string };
  items: { lineNo: number; medicineId: string; name: string; strength: string | null; dose: string; frequency: string; durationDays: number; quantity: number }[];
  checks: { allergyConflicts: string[]; majorInteractions: { effect: string }[] };
}

export async function prescriptionReview(db: Queryable, rxId: string, now: Date = new Date()): Promise<PrescriptionReview> {
  const h = (await db.query<{
    id: string; rx_number: string | null; status: StoredStatus; valid_till: string | null; issued_at: Date | null;
    patient_name: string; dob: string; doctor_name: string; specialty: string; registration_no: string;
  }>(
    `SELECT p.id, p.rx_number, p.status, to_char(p.valid_till, 'YYYY-MM-DD') AS valid_till, p.issued_at,
            pp.full_name AS patient_name, to_char(pp.dob, 'YYYY-MM-DD') AS dob,
            d.display_name AS doctor_name, d.specialty, d.registration_no
       FROM prescriptions p
       JOIN patient_profiles pp ON pp.user_id = p.patient_user_id
       JOIN doctor_profiles d ON d.user_id = p.doctor_user_id
      WHERE p.id = $1 AND p.status <> 'DRAFT'
        AND (EXISTS (SELECT 1 FROM order_items oi WHERE oi.prescription_id = p.id)
             OR EXISTS (SELECT 1 FROM fulfilments f WHERE f.prescription_id = p.id))`,
    [rxId],
  )).rows[0];
  // Not found and not linked to pharmacy work look the same, so probing reveals nothing.
  if (!h) throw notFound('Prescription not found');

  const items = (await db.query<{ line_no: number; medicine_id: string; name: string; strength: string | null; dose: string; frequency: string; duration_days: number; quantity: number }>(
    `SELECT line_no, medicine_id, medicine_name_snapshot AS name, strength_snapshot AS strength, dose, frequency, duration_days, quantity
       FROM prescription_items WHERE prescription_id = $1 ORDER BY line_no`,
    [rxId],
  )).rows;
  const checks = await dispensingChecks(db, rxId);

  return {
    id: h.id,
    rxNumber: h.rx_number,
    status: effectiveStatus(h.status, h.valid_till, istDateOf(now)),
    validTill: h.valid_till,
    issuedAt: h.issued_at ? h.issued_at.toISOString() : null,
    patient: { name: h.patient_name, age: ageFromDob(h.dob) },
    doctor: { name: h.doctor_name, specialty: h.specialty, registrationNo: h.registration_no },
    items: items.map((i) => ({
      lineNo: i.line_no,
      medicineId: i.medicine_id,
      name: i.name,
      strength: i.strength,
      dose: i.dose,
      frequency: i.frequency,
      durationDays: i.duration_days,
      quantity: i.quantity,
    })),
    checks: {
      allergyConflicts: checks.allergyMatches.map((m) => m.medicineName),
      majorInteractions: checks.majorInteractions.map((r) => ({ effect: r.effect })),
    },
  };
}
