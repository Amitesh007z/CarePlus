import { z } from 'zod';
import { pageQuery, calendarDate } from '../../common/http.js';

export const SEVERITY_VALUES = ['MILD', 'MODERATE', 'SEVERE'] as const;

/**
 * Patient booking. The patient submits symptoms, never a diagnosis. `.strict()` rejects
 * any client-supplied patientId, doctorId, status or fee.
 */
export const bookSchema = z
  .object({
    slotId: z.uuid({ message: 'Choose a valid time slot' }),
    chiefComplaint: z.string().trim().min(3, 'Describe your main concern').max(200),
    symptoms: z.array(z.string().trim().min(2).max(60)).max(15).default([]),
    durationDays: z.number().int().min(0, 'Duration cannot be negative').max(3650),
    severity: z.enum(SEVERITY_VALUES),
    additionalNotes: z.string().trim().max(1000).nullish(),
  })
  .strict();
export type BookInput = z.infer<typeof bookSchema>;

export const cancelSchema = z.object({ reason: z.string().trim().max(300).nullish() }).strict();
export const rescheduleSchema = z.object({ slotId: z.uuid({ message: 'Choose a valid time slot' }) }).strict();
export const doctorStatusSchema = z.object({ status: z.enum(['CONFIRMED', 'COMPLETED']) }).strict();

export const patientListQuery = pageQuery.extend({
  scope: z.enum(['upcoming', 'past', 'all']).default('upcoming'),
});

export const doctorListQuery = pageQuery.extend({
  from: calendarDate.optional(),
  to: calendarDate.optional(),
  status: z.enum(['REQUESTED', 'CONFIRMED', 'COMPLETED', 'CANCELLED']).optional(),
});
