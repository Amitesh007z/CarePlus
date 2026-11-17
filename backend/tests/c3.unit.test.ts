import { describe, expect, it } from 'vitest';
import { addendumSchema, consultationDraftSchema, vitalsSchema } from '../src/modules/consultations/consultations.schemas.js';
import { redFlagReasons } from '../src/modules/appointments/redFlags.js';

const goodVitals = { bpSystolic: 120, bpDiastolic: 80, pulse: 72, temperatureC: 37.2, spo2: 98 };
const draft = {
  chiefComplaint: 'Fever for two days',
  examinationNotes: null,
  diagnosisDescription: 'Viral fever (provisional)',
  severity: 'MILD',
  followUpOn: null,
  vitals: goodVitals,
};

describe('vitals input checks', () => {
  it('accepts plausible values and a complete reading', () => {
    expect(vitalsSchema.safeParse(goodVitals).success).toBe(true);
    expect(vitalsSchema.safeParse({ ...goodVitals, bpSystolic: null, bpDiastolic: null }).success).toBe(true);
  });

  it.each([
    ['systolic not above diastolic', { bpSystolic: 80, bpDiastolic: 120 }],
    ['only one blood pressure value', { bpDiastolic: null }],
    ['SpO2 above 100', { spo2: 101 }],
    ['temperature with two decimals', { temperatureC: 36.55 }],
    ['temperature out of range', { temperatureC: 52 }],
    ['pulse out of range', { pulse: 500 }],
    ['unknown key', { oxygen: 99 }],
  ])('rejects %s', (_name, patch) => {
    expect(vitalsSchema.safeParse({ ...goodVitals, ...patch }).success).toBe(false);
  });
});

describe('consultation input', () => {
  it('accepts a full draft and rejects client-supplied ownership or status fields', () => {
    expect(consultationDraftSchema.safeParse(draft).success).toBe(true);
    expect(consultationDraftSchema.safeParse({ ...draft, status: 'FINALIZED' }).success).toBe(false);
    expect(consultationDraftSchema.safeParse({ ...draft, doctorId: 'x' }).success).toBe(false);
    expect(consultationDraftSchema.safeParse({ ...draft, diagnosisDescription: 'ab' }).success).toBe(false);
  });

  it('requires addenda to contain real text', () => {
    expect(addendumSchema.safeParse({ content: 'Corrected pulse reading' }).success).toBe(true);
    expect(addendumSchema.safeParse({ content: '' }).success).toBe(false);
  });
});

describe('deterministic red-flag escalation', () => {
  it('escalates the examples named in the brief', () => {
    expect(redFlagReasons('severe chest pain since this morning')).toEqual(['chest pain']);
    expect(redFlagReasons('I have difficulty breathing')).toEqual(['breathing difficulty']);
    expect(redFlagReasons('face drooping and slurred speech')).toEqual(['possible stroke signs']);
  });

  it('does not escalate ordinary complaints', () => {
    expect(redFlagReasons('mild fever and a runny nose')).toEqual([]);
  });
});
