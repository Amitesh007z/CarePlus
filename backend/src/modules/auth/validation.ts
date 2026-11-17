import { z } from 'zod';

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Indian mobile: accepts +91 / 91 / 0 prefixes and separators; returns the bare 10 digits or null. */
export function normalizeMobile(raw: string): string | null {
  let digits = raw.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

export function passwordIssues(password: string): string[] {
  const issues: string[] = [];
  if (password.length < 8) issues.push('at least 8 characters');
  if (password.length > 128) issues.push('at most 128 characters');
  if (!/[a-z]/.test(password)) issues.push('a lowercase letter');
  if (!/[A-Z]/.test(password)) issues.push('an uppercase letter');
  if (!/\d/.test(password)) issues.push('a digit');
  if (!/[^A-Za-z0-9]/.test(password)) issues.push('a special character');
  return issues;
}

const email = z
  .string()
  .trim()
  .max(254)
  .email('Enter a valid email address')
  .transform(normalizeEmail);

const mobile = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const n = normalizeMobile(v);
    if (!n) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid 10-digit Indian mobile number' });
      return z.NEVER;
    }
    return n;
  });

const password = z.string().superRefine((v, ctx) => {
  const issues = passwordIssues(v);
  if (issues.length) ctx.addIssue({ code: 'custom', message: `Password needs ${issues.join(', ')}` });
});

const dob = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .superRefine((v, ctx) => {
    const d = new Date(`${v}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid date' });
      return;
    }
    const now = new Date();
    if (d > now) ctx.addIssue({ code: 'custom', message: 'Date of birth cannot be in the future' });
    else if (now.getUTCFullYear() - d.getUTCFullYear() > 120) ctx.addIssue({ code: 'custom', message: 'Enter a valid date of birth' });
  });

const text = (label: string, min = 2, max = 120) =>
  z.string().trim().min(min, `${label} is required`).max(max, `${label} is too long`);

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'UNKNOWN'] as const;
export const GENDERS = ['MALE', 'FEMALE', 'OTHER'] as const;

/** `.strict()` rejects unknown keys, so a client-supplied `role` (or any other field) is refused outright. */
export const registerSchema = z
  .object({
    fullName: text('Full name'),
    email,
    mobile,
    password,
    dob,
    gender: z.enum(GENDERS),
    bloodGroup: z.enum(BLOOD_GROUPS),
    addressLine: text('Address', 5, 200),
    city: text('City'),
    state: text('State'),
    pincode: z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits'),
    emergencyContactName: text('Emergency contact name'),
    emergencyContactPhone: mobile,
    consent: z.literal(true, { error: 'Consent to store and share health data is required' }),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z
  .object({
    identifier: z.string().trim().min(3).max(254),
    password: z.string().min(1).max(128),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;
