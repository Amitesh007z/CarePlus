/**
 * Appointment business rules as pure functions, so they can be unit-tested without a database.
 * Source policy: free reschedule/cancel up to 2 hours before the slot; inside 2 hours a cancellation
 * forfeits the INR 100 booking fee. The fee is SIMULATED: no payment is taken or refunded.
 */

export const BOOKING_FEE_INR = 100;
export const FREE_CHANGE_WINDOW_MS = 2 * 60 * 60 * 1000;

export type AppointmentStatus = 'REQUESTED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';
export type FeeStatus = 'SIMULATED_HELD' | 'SIMULATED_RELEASED' | 'SIMULATED_FORFEITED';

/** Statuses that occupy a slot. Mirrors the partial unique index in migration 0003. */
export const OCCUPYING_STATUSES: readonly AppointmentStatus[] = ['REQUESTED', 'CONFIRMED', 'COMPLETED'];

const TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  REQUESTED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export type CancellationPolicy =
  | { allowed: false }
  | { allowed: true; lateWindow: boolean; fee: FeeStatus };

export function cancellationPolicy(slotStart: Date, now: Date): CancellationPolicy {
  if (slotStart.getTime() <= now.getTime()) return { allowed: false };
  const lateWindow = slotStart.getTime() - now.getTime() < FREE_CHANGE_WINDOW_MS;
  return { allowed: true, lateWindow, fee: lateWindow ? 'SIMULATED_FORFEITED' : 'SIMULATED_RELEASED' };
}

/** Rescheduling is free only while the current slot is at least 2 hours away. */
export function reschedulePermitted(slotStart: Date, now: Date): boolean {
  return slotStart.getTime() - now.getTime() >= FREE_CHANGE_WINDOW_MS;
}
