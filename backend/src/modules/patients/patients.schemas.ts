import { z } from 'zod';
import { normalizeMobile } from '../auth/validation.js';
import { pageQuery, pastOrTodayDate } from '../../common/http.js';

export const BLOOD_GROUP = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'UNKNOWN'] as const;
export const GENDER = ['MALE', 'FEMALE', 'OTHER'] as const;
export const SEVERITY = ['MILD', 'MODERATE', 'SEVERE'] as const;
export const HEALTH_TYPE = ['ALLERGY', 'CONDITION'] as const;

const text = (min: number, max: number, label: string) =>
  z.string().trim().min(min, `${label} is required`).max(max, `${label} is too long`);

const mobile = z.string().trim().transform((v, ctx) => {
  const n = normalizeMobile(v);
  if (!n) {
    ctx.addIssue({ code: 'custom', message: 'Enter a valid 10-digit Indian mobile number' });
    return z.NEVER;
  }
  return n;
});

const dobSchema = pastOrTodayDate.refine(
  (v) => (Date.now() - Date.parse(`${v}T00:00:00Z`)) / (365.25 * 86_400_000) <= 120,
  'Enter a valid date of birth',
);

/** PUT /patients/me. Full replacement of editable fields; `.strict()` rejects unknown keys. */
export const profileUpdateSchema = z
  .object({
    fullName: text(2, 120, 'Full name'),
    dob: dobSchema,
    gender: z.enum(GENDER),
    bloodGroup: z.enum(BLOOD_GROUP),
    addressLine: text(5, 200, 'Address'),
    city: text(2, 120, 'City'),
    state: text(2, 120, 'State'),
    pincode: z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits'),
    emergencyContactName: text(2, 120, 'Emergency contact name'),
    emergencyContactPhone: mobile,
  })
  .strict();
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

export const consentSchema = z.object({ granted: z.boolean() }).strict();

export const healthCreateSchema = z
  .object({
    type: z.enum(HEALTH_TYPE),
    name: text(2, 120, 'Name'),
    allergyClass: z.string().trim().min(2).max(60).nullish(),
    severity: z.enum(SEVERITY).nullish(),
    notedOn: pastOrTodayDate,
    notes: z.string().trim().max(500).nullish(),
  })
  .strict()
  .refine((v) => v.type === 'ALLERGY' || !v.allergyClass, {
    message: 'Allergy class applies only to allergies',
    path: ['allergyClass'],
  });
export type HealthCreate = z.infer<typeof healthCreateSchema>;

/** Editing is allowed without re-consenting: it never adds new health data. */
export const healthUpdateSchema = z
  .object({
    active: z.boolean().optional(),
    severity: z.enum(SEVERITY).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type HealthUpdate = z.infer<typeof healthUpdateSchema>;

export const healthListQuery = pageQuery.extend({ type: z.enum(HEALTH_TYPE).optional() });

export const medicationCreateSchema = z
  .object({
    medicationName: text(2, 120, 'Medication name'),
    dose: z.string().trim().max(60).nullish(),
    frequency: z.string().trim().max(60).nullish(),
    startedOn: pastOrTodayDate,
  })
  .strict();
export type MedicationCreate = z.infer<typeof medicationCreateSchema>;

/** Only stopping a medication is supported; stopped entries stay in history. */
export const medicationStopSchema = z.object({ active: z.literal(false) }).strict();
