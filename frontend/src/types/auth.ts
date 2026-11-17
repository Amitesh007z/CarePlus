export type Role = 'PATIENT' | 'DOCTOR' | 'PHARMACIST' | 'ADMIN';

export interface PatientInfo {
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

export interface DoctorInfo {
  specialty: string;
  registrationNo: string;
  experienceYears: number;
}

export interface SessionUser {
  id: string;
  role: Role;
  email: string;
  mobile: string | null;
  emailVerified: boolean;
  displayName: string;
  createdAt: string;
  patient?: PatientInfo;
  doctor?: DoctorInfo;
}

export interface SessionPayload {
  user: SessionUser;
  csrfToken: string;
}

/** Public registration body. Deliberately has no role field: the server always creates a PATIENT. */
export interface RegistrationPayload {
  fullName: string;
  email: string;
  mobile: string;
  password: string;
  dob: string;
  gender: 'MALE' | 'FEMALE' | 'OTHER';
  bloodGroup: 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-' | 'O+' | 'O-' | 'UNKNOWN';
  addressLine: string;
  city: string;
  state: string;
  pincode: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  consent: true;
}

export interface RoleMeta {
  label: string;
  dashboardPath: string;
  /** Full Tailwind class strings (kept literal so the compiler can detect them). */
  hero: string;
  chip: string;
  icon: string;
}

export const ROLE_META: Record<Role, RoleMeta> = {
  PATIENT: {
    label: 'Patient',
    dashboardPath: '/patient/dashboard',
    hero: 'bg-gradient-to-br from-teal-600 via-emerald-500 to-cyan-500',
    chip: 'bg-teal-50 text-teal-700 ring-teal-200',
    icon: 'bg-teal-100 text-teal-700',
  },
  DOCTOR: {
    label: 'Doctor',
    dashboardPath: '/doctor/dashboard',
    hero: 'bg-gradient-to-br from-indigo-600 via-violet-500 to-sky-500',
    chip: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
    icon: 'bg-indigo-100 text-indigo-700',
  },
  PHARMACIST: {
    label: 'Pharmacist',
    dashboardPath: '/pharmacy/dashboard',
    hero: 'bg-gradient-to-br from-emerald-600 via-green-500 to-lime-500',
    chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    icon: 'bg-emerald-100 text-emerald-700',
  },
  ADMIN: {
    label: 'Admin',
    dashboardPath: '/admin/dashboard',
    hero: 'bg-gradient-to-br from-amber-500 via-orange-500 to-rose-500',
    chip: 'bg-amber-50 text-amber-800 ring-amber-200',
    icon: 'bg-amber-100 text-amber-800',
  },
};
