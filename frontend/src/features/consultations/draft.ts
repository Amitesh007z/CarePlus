import type { ConsultationDetail } from '../../types/clinical';

/** Form values are strings; they are converted and checked before anything is sent. */
export interface DraftValues {
  chiefComplaint: string;
  examinationNotes: string;
  diagnosisDescription: string;
  severity: string;
  followUpOn: string;
  bpSystolic: string;
  bpDiastolic: string;
  pulse: string;
  temperatureC: string;
  spo2: string;
}

export type DraftBody = {
  chiefComplaint: string | null;
  examinationNotes: string | null;
  diagnosisDescription: string | null;
  severity: 'MILD' | 'MODERATE' | 'SEVERE' | null;
  followUpOn: string | null;
  vitals: { bpSystolic: number | null; bpDiastolic: number | null; pulse: number | null; temperatureC: number | null; spo2: number | null } | null;
};

export function valuesFrom(c: ConsultationDetail): DraftValues {
  const v = c.vitals;
  return {
    chiefComplaint: c.chiefComplaint ?? '',
    examinationNotes: c.examinationNotes ?? '',
    diagnosisDescription: c.diagnosis.description ?? '',
    severity: c.severity ?? '',
    followUpOn: c.followUpOn ?? '',
    bpSystolic: v?.bpSystolic?.toString() ?? '',
    bpDiastolic: v?.bpDiastolic?.toString() ?? '',
    pulse: v?.pulse?.toString() ?? '',
    temperatureC: v?.temperatureC?.toString() ?? '',
    spo2: v?.spo2?.toString() ?? '',
  };
}

const num = (s: string) => (s.trim() === '' ? null : Number(s));

/** Mirrors the server's input checks for fast feedback. The server remains the authority. */
export function validate(v: DraftValues): Partial<Record<keyof DraftValues, string>> {
  const e: Partial<Record<keyof DraftValues, string>> = {};
  const sys = num(v.bpSystolic);
  const dia = num(v.bpDiastolic);
  if ((sys === null) !== (dia === null)) e.bpDiastolic = 'Enter both blood pressure values, or neither';
  else if (sys !== null && dia !== null && sys <= dia) e.bpSystolic = 'Systolic must be higher than diastolic';
  if (sys !== null && (!Number.isInteger(sys) || sys < 60 || sys > 260)) e.bpSystolic = 'Systolic looks out of range (60–260)';
  if (dia !== null && (!Number.isInteger(dia) || dia < 30 || dia > 160)) e.bpDiastolic = 'Diastolic looks out of range (30–160)';
  const pulse = num(v.pulse);
  if (pulse !== null && (!Number.isInteger(pulse) || pulse < 30 || pulse > 230)) e.pulse = 'Pulse looks out of range (30–230)';
  const temp = num(v.temperatureC);
  if (temp !== null && (temp < 30 || temp > 45 || Math.round(temp * 10) !== temp * 10)) e.temperatureC = 'Temperature: 30–45 °C, one decimal place';
  const spo2 = num(v.spo2);
  if (spo2 !== null && (!Number.isInteger(spo2) || spo2 < 50 || spo2 > 100)) e.spo2 = 'SpO₂ must be a whole number from 50 to 100';
  if (v.chiefComplaint.trim() && v.chiefComplaint.trim().length < 3) e.chiefComplaint = 'At least 3 characters';
  if (v.diagnosisDescription.trim() && v.diagnosisDescription.trim().length < 3) e.diagnosisDescription = 'At least 3 characters';
  return e;
}

export function toBody(v: DraftValues): DraftBody {
  const vitalsEmpty = [v.bpSystolic, v.bpDiastolic, v.pulse, v.temperatureC, v.spo2].every((x) => x.trim() === '');
  const blank = (s: string) => (s.trim() === '' ? null : s.trim());
  return {
    chiefComplaint: blank(v.chiefComplaint),
    examinationNotes: blank(v.examinationNotes),
    diagnosisDescription: blank(v.diagnosisDescription),
    severity: (v.severity || null) as DraftBody['severity'],
    followUpOn: blank(v.followUpOn),
    vitals: vitalsEmpty
      ? null
      : { bpSystolic: num(v.bpSystolic), bpDiastolic: num(v.bpDiastolic), pulse: num(v.pulse), temperatureC: num(v.temperatureC), spo2: num(v.spo2) },
  };
}

