export type Severity = 'MILD' | 'MODERATE' | 'SEVERE';
export type AppointmentStatus = 'REQUESTED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface HealthItem {
  id: string;
  type: 'ALLERGY' | 'CONDITION';
  name: string;
  allergyClass: string | null;
  severity: Severity | null;
  notedOn: string;
  active: boolean;
  notes: string | null;
}

export interface Medication {
  id: string;
  medicationName: string;
  dose: string | null;
  frequency: string | null;
  startedOn: string;
  endedOn: string | null;
  active: boolean;
}

export interface DoctorSummary {
  id: string;
  displayName: string;
  specialty: string;
  experienceYears: number;
}

export interface DoctorDetail extends DoctorSummary {
  availability: { weekday: number; startTime: string; endTime: string; slotMinutes: number }[];
}

export interface Slot {
  id: string;
  startsAt: string;
  endsAt: string;
  booked: boolean;
}

export interface SlotsResponse {
  timezone: string;
  from: string;
  days: number;
  slots: Slot[];
}

export interface Appointment {
  id: string;
  status: AppointmentStatus;
  chiefComplaint: string;
  symptoms: string[];
  durationDays: number;
  severity: Severity;
  additionalNotes: string | null;
  doctor: { id: string; name: string; specialty: string };
  patient: { id: string; name: string };
  slot: { id: string; startsAt: string; endsAt: string };
  booking: { feeInr: number; feeStatus: 'SIMULATED_HELD' | 'SIMULATED_RELEASED' | 'SIMULATED_FORFEITED' };
  cancellation: { at: string; by: string | null; reason: string | null } | null;
  rescheduledCount: number;
  createdAt: string;
}

export interface PatientContext {
  patient: { fullName: string; age: number; gender: string; bloodGroup: string };
  allergies: { name: string; allergyClass: string | null; severity: Severity | null; notedOn: string; notes: string | null }[];
  conditions: { name: string; severity: Severity | null; notedOn: string; notes: string | null }[];
  medications: { medicationName: string; dose: string | null; frequency: string | null; startedOn: string }[];
}

export const SEVERITY_OPTIONS = [
  { value: 'MILD', label: 'Mild' },
  { value: 'MODERATE', label: 'Moderate' },
  { value: 'SEVERE', label: 'Severe' },
] as const;

/** Suggestion chips only. Patients describe symptoms; they never pick a diagnosis. */
export const SYMPTOM_SUGGESTIONS = [
  'Fever', 'Cough', 'Sore throat', 'Headache', 'Body ache', 'Runny nose',
  'Stomach pain', 'Nausea', 'Dizziness', 'Rash', 'Fatigue', 'Breathlessness',
];
