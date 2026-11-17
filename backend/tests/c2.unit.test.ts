import { describe, expect, it } from 'vitest';
import { AppError } from '../src/common/errors/AppError.js';
import { calendarDate, pageQuery, parseUuid } from '../src/common/http.js';
import { addDays, istDateOf, istInstant, slotsForDate, weekdayOf } from '../src/common/time.js';
import { bookSchema } from '../src/modules/appointments/appointments.schemas.js';
import { canTransition, cancellationPolicy, reschedulePermitted } from '../src/modules/appointments/policy.js';
import { healthCreateSchema, profileUpdateSchema } from '../src/modules/patients/patients.schemas.js';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-16T04:00:00Z'); // 09:30 IST, Monday

describe('clinic time (IST)', () => {
  it('maps dates to weekdays and IST day boundaries', () => {
    expect(weekdayOf('2026-11-16')).toBe(1);
    expect(istDateOf(new Date('2026-11-16T20:00:00Z'))).toBe('2026-11-17');
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
    expect(istInstant('2026-11-16', '09:00').toISOString()).toBe('2026-11-16T03:30:00.000Z');
  });

  it('expands weekly rules into slots for matching weekdays only', () => {
    const rules = [{ weekday: 1, startTime: '09:00:00', endTime: '10:30:00', slotMinutes: 30 }];
    const monday = slotsForDate('2026-11-16', rules);
    expect(monday.map((s) => s.startsAt.toISOString())).toEqual([
      '2026-11-16T03:30:00.000Z',
      '2026-11-16T04:00:00.000Z',
      '2026-11-16T04:30:00.000Z',
    ]);
    expect(slotsForDate('2026-11-17', rules)).toEqual([]);
  });
});

describe('appointment policy', () => {
  it('releases the simulated fee when cancelling 2 or more hours ahead, forfeits it inside 2 hours', () => {
    expect(cancellationPolicy(new Date(NOW.getTime() + 3 * HOUR), NOW)).toMatchObject({ allowed: true, fee: 'SIMULATED_RELEASED' });
    expect(cancellationPolicy(new Date(NOW.getTime() + 2 * HOUR), NOW)).toMatchObject({ allowed: true, fee: 'SIMULATED_RELEASED' });
    expect(cancellationPolicy(new Date(NOW.getTime() + HOUR), NOW)).toMatchObject({ allowed: true, fee: 'SIMULATED_FORFEITED', lateWindow: true });
    expect(cancellationPolicy(new Date(NOW.getTime() - HOUR), NOW)).toEqual({ allowed: false });
  });

  it('allows rescheduling only while the current slot is at least 2 hours away', () => {
    expect(reschedulePermitted(new Date(NOW.getTime() + 3 * HOUR), NOW)).toBe(true);
    expect(reschedulePermitted(new Date(NOW.getTime() + HOUR), NOW)).toBe(false);
  });

  it('enforces the status transition table', () => {
    expect(canTransition('REQUESTED', 'CONFIRMED')).toBe(true);
    expect(canTransition('CONFIRMED', 'COMPLETED')).toBe(true);
    expect(canTransition('REQUESTED', 'COMPLETED')).toBe(false);
    expect(canTransition('COMPLETED', 'CANCELLED')).toBe(false);
    expect(canTransition('CANCELLED', 'CONFIRMED')).toBe(false);
  });
});

describe('request schemas (boundary validation)', () => {
  const booking = {
    slotId: '6f1c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6',
    chiefComplaint: 'Fever for two days',
    symptoms: ['fever'],
    durationDays: 2,
    severity: 'MODERATE',
  };

  it('books with symptoms only and rejects client-supplied ownership, status or fee fields', () => {
    expect(bookSchema.parse(booking).symptoms).toEqual(['fever']);
    expect(bookSchema.safeParse({ ...booking, patientId: booking.slotId }).success).toBe(false);
    expect(bookSchema.safeParse({ ...booking, doctorId: booking.slotId }).success).toBe(false);
    expect(bookSchema.safeParse({ ...booking, status: 'CONFIRMED' }).success).toBe(false);
    expect(bookSchema.safeParse({ ...booking, durationDays: -1 }).success).toBe(false);
  });

  const profile = {
    fullName: 'Anita Rao', dob: '1991-04-12', gender: 'FEMALE', bloodGroup: 'B+', addressLine: '14 Lakeview Road',
    city: 'Bengaluru', state: 'Karnataka', pincode: '560038', emergencyContactName: 'Suresh Rao',
    emergencyContactPhone: '+91 98765 00101',
  };

  it('validates profile fields, normalises mobile and refuses unknown keys', () => {
    expect(profileUpdateSchema.parse(profile).emergencyContactPhone).toBe('9876500101');
    expect(profileUpdateSchema.safeParse({ ...profile, pincode: '12' }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ ...profile, role: 'ADMIN' }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ ...profile, dob: '2999-01-01' }).success).toBe(false);
  });

  it('allows a class only for allergies and requires real calendar dates', () => {
    const allergy = { type: 'ALLERGY', name: 'Penicillin', allergyClass: 'Penicillin', notedOn: '2015-03-10' };
    expect(healthCreateSchema.safeParse(allergy).success).toBe(true);
    expect(healthCreateSchema.safeParse({ ...allergy, type: 'CONDITION' }).success).toBe(false);
    expect(calendarDate.safeParse('2026-02-30').success).toBe(false);
  });

  it('caps page size and rejects malformed ids as not found', () => {
    expect(pageQuery.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(pageQuery.safeParse({ pageSize: '500' }).success).toBe(false);
    expect(() => parseUuid('not-a-uuid')).toThrow(AppError);
  });
});
