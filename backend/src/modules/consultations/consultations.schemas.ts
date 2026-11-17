import { z } from 'zod';
import { calendarDate } from '../../common/http.js';
import { istDateOf } from '../../common/time.js';

export const SEVERITY = ['MILD', 'MODERATE', 'SEVERE'] as const;

/**
 * Input sanity ranges, not clinical thresholds. They catch typing errors (for example SpO2 of 980)
 * and say nothing about whether a value is normal.
 */
export const vitalsSchema = z
  .object({
    bpSystolic: z.number().int().min(60, 'Systolic BP looks out of range').max(260, 'Systolic BP looks out of range').nullable(),
    bpDiastolic: z.number().int().min(30, 'Diastolic BP looks out of range').max(160, 'Diastolic BP looks out of range').nullable(),
    pulse: z.number().int().min(30, 'Pulse looks out of range').max(230, 'Pulse looks out of range').nullable(),
    temperatureC: z
      .number()
      .min(30, 'Temperature looks out of range')
      .max(45, 'Temperature looks out of range')
      .refine((v) => Math.round(v * 10) === v * 10, 'Temperature takes one decimal place')
      .nullable(),
    spo2: z.number().int().min(50, 'SpO2 looks out of range').max(100, 'SpO2 cannot exceed 100').nullable(),
  })
  .strict()
  .refine((v) => (v.bpSystolic === null) === (v.bpDiastolic === null), {
    message: 'Enter both blood pressure values, or neither',
    path: ['bpDiastolic'],
  })
  .refine((v) => v.bpSystolic === null || v.bpDiastolic === null || v.bpSystolic > v.bpDiastolic, {
    message: 'Systolic must be higher than diastolic',
    path: ['bpSystolic'],
  });
export type Vitals = z.infer<typeof vitalsSchema>;

const futureOrToday = calendarDate.refine((v) => v >= istDateOf(new Date()), 'Follow-up date cannot be in the past');

/** Full replacement of a draft. Every field is present; null clears it. Unknown keys are rejected. */
export const consultationDraftSchema = z
  .object({
    chiefComplaint: z.string().trim().min(3, 'Chief complaint needs at least 3 characters').max(500).nullable(),
    examinationNotes: z.string().trim().max(4000).nullable(),
    diagnosisDescription: z.string().trim().min(3, 'Describe the diagnosis (at least 3 characters)').max(500).nullable(),
    severity: z.enum(SEVERITY).nullable(),
    followUpOn: futureOrToday.nullable(),
    vitals: vitalsSchema.nullable(),
  })
  .strict();
export type ConsultationDraft = z.infer<typeof consultationDraftSchema>;

export const addendumSchema = z.object({ content: z.string().trim().min(3, 'Write the correction (at least 3 characters)').max(2000) }).strict();
