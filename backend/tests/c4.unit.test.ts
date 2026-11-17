import { describe, expect, it } from 'vitest';
import { AppError } from '../src/common/errors/AppError.js';
import { assertDispensable, effectiveStatus, formatRxNumber, matchAllergies } from '../src/modules/prescriptions/prescriptions.service.js';
import { itemCreateSchema } from '../src/modules/prescriptions/prescriptions.schemas.js';

const item = (sku: string, name: string, allergyClass: string | null) => ({ sku, name, allergyClass });

describe('deterministic allergy matching', () => {
  it('matches a penicillin allergy to a penicillin-class medicine (case-insensitive, exact)', () => {
    const matches = matchAllergies(
      [item('MED-1002', 'Amoxicillin 500 mg capsule', 'Penicillin')],
      [{ name: 'Penicillin', allergyClass: 'penicillin' }],
    );
    expect(matches).toEqual([expect.objectContaining({ medicineSku: 'MED-1002', matchedOn: 'ALLERGY_CLASS' })]);
  });

  it('does not infer cross-reactivity or unlisted relationships', () => {
    expect(matchAllergies([item('MED-1001', 'Azithromycin', 'Macrolide')], [{ name: 'Penicillin', allergyClass: 'Penicillin' }])).toEqual([]);
    expect(matchAllergies([item('MED-1006', 'Paracetamol', null)], [{ name: 'Penicillin', allergyClass: 'Penicillin' }])).toEqual([]);
  });

  it('falls back to the allergy name only when the allergy has no class', () => {
    expect(matchAllergies([item('MED-1002', 'Amoxicillin', 'Penicillin')], [{ name: 'Penicillin', allergyClass: null }])).toHaveLength(1);
  });
});

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.code : 'NON_APP_ERROR';
  }
}

describe('derived expiry and dispensing rules', () => {
  it('derives EXPIRED from valid_till without changing the stored status', () => {
    expect(effectiveStatus('ISSUED', '2026-12-17', '2026-12-17')).toBe('ISSUED');
    expect(effectiveStatus('ISSUED', '2026-12-17', '2026-12-18')).toBe('EXPIRED');
    expect(effectiveStatus('FULFILLED', '2026-12-17', '2026-12-18')).toBe('FULFILLED');
  });

  it('allows dispensing only a live issued prescription', () => {
    expect(() => assertDispensable('ISSUED', '2026-12-30', '2026-12-18')).not.toThrow();
    expect(codeOf(() => assertDispensable('FULFILLED', '2026-12-30', '2026-12-18'))).toBe('ALREADY_FULFILLED');
    expect(codeOf(() => assertDispensable('ISSUED', '2026-12-01', '2026-12-18'))).toBe('EXPIRED');
    expect(codeOf(() => assertDispensable('DRAFT', null, '2026-12-18'))).toBe('NOT_ISSUED');
    expect(codeOf(() => assertDispensable('SUPERSEDED', '2026-12-30', '2026-12-18'))).toBe('SUPERSEDED');
  });

  it('formats prescription numbers with a year and a six-digit sequence', () => {
    expect(formatRxNumber(42, '2026')).toBe('CP-2026-000042');
  });
});

describe('medicine line validation', () => {
  const line = { medicineId: '6f1c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6', dose: '500 mg', frequency: 'Twice a day', durationDays: 3, quantity: 6 };

  it('accepts a valid line and rejects bad quantities, durations and extra fields', () => {
    expect(itemCreateSchema.safeParse(line).success).toBe(true);
    expect(itemCreateSchema.safeParse({ ...line, quantity: 0 }).success).toBe(false);
    expect(itemCreateSchema.safeParse({ ...line, quantity: 101 }).success).toBe(false);
    expect(itemCreateSchema.safeParse({ ...line, quantity: 2.5 }).success).toBe(false);
    expect(itemCreateSchema.safeParse({ ...line, durationDays: 0 }).success).toBe(false);
    expect(itemCreateSchema.safeParse({ ...line, medicineId: 'not-a-uuid' }).success).toBe(false);
    expect(itemCreateSchema.safeParse({ ...line, unitPriceInr: 1 }).success).toBe(false);
    expect(itemCreateSchema.safeParse({ ...line, allergyClass: null }).success).toBe(false);
  });
});
