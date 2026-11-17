import type { Queryable } from '../../infrastructure/database/pool.js';
import type { Role } from './session.service.js';

export interface PatientProfileView {
  fullName: string;
  dob: string;
  age: number;
  gender: string;
  bloodGroup: string;
  addressLine: string;
  city: string;
  state: string;
  pincode: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  consentStatus: boolean;
  consentAt: string | null;
}

export interface UserView {
  id: string;
  role: Role;
  email: string;
  mobile: string | null;
  emailVerified: boolean;
  displayName: string;
  createdAt: string;
  patient?: PatientProfileView;
  doctor?: { specialty: string; registrationNo: string; experienceYears: number };
}

export function ageFromDob(dob: string, now = new Date()): number {
  const d = new Date(`${dob}T00:00:00Z`);
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

interface Row {
  id: string;
  role: Role;
  email: string;
  mobile: string | null;
  email_verified_at: Date | null;
  created_at: Date;
  full_name: string | null;
  dob: string | null;
  gender: string | null;
  blood_group: string | null;
  address_line: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  consent_status: boolean | null;
  consent_at: Date | null;
  doctor_name: string | null;
  specialty: string | null;
  registration_no: string | null;
  experience_years: number | null;
  pharmacist_name: string | null;
  admin_name: string | null;
}

/** One query that joins whichever role profile exists. Never selects password_hash. */
export async function loadUserView(db: Queryable, userId: string): Promise<UserView | null> {
  const r = await db.query<Row>(
    `SELECT u.id, u.role, u.email, u.mobile, u.email_verified_at, u.created_at,
            pp.full_name, to_char(pp.dob, 'YYYY-MM-DD') AS dob, pp.gender, pp.blood_group, pp.address_line,
            pp.city, pp.state, pp.pincode, pp.emergency_contact_name, pp.emergency_contact_phone,
            pp.consent_status, pp.consent_at,
            dp.display_name AS doctor_name, dp.specialty, dp.registration_no, dp.experience_years,
            ph.display_name AS pharmacist_name, ad.display_name AS admin_name
       FROM users u
       LEFT JOIN patient_profiles pp ON pp.user_id = u.id
       LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
       LEFT JOIN pharmacist_profiles ph ON ph.user_id = u.id
       LEFT JOIN admin_profiles ad ON ad.user_id = u.id
      WHERE u.id = $1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return null;

  const view: UserView = {
    id: row.id,
    role: row.role,
    email: row.email,
    mobile: row.mobile,
    emailVerified: row.email_verified_at !== null,
    displayName: row.full_name ?? row.doctor_name ?? row.pharmacist_name ?? row.admin_name ?? row.email,
    createdAt: row.created_at.toISOString(),
  };
  if (row.role === 'PATIENT' && row.full_name && row.dob) {
    view.patient = {
      fullName: row.full_name,
      dob: row.dob,
      age: ageFromDob(row.dob),
      gender: row.gender ?? '',
      bloodGroup: row.blood_group ?? '',
      addressLine: row.address_line ?? '',
      city: row.city ?? '',
      state: row.state ?? '',
      pincode: row.pincode ?? '',
      emergencyContactName: row.emergency_contact_name ?? '',
      emergencyContactPhone: row.emergency_contact_phone ?? '',
      consentStatus: row.consent_status ?? false,
      consentAt: row.consent_at ? row.consent_at.toISOString() : null,
    };
  }
  if (row.role === 'DOCTOR' && row.specialty) {
    view.doctor = {
      specialty: row.specialty,
      registrationNo: row.registration_no ?? '',
      experienceYears: row.experience_years ?? 0,
    };
  }
  return view;
}
