import type { RegistrationPayload } from '../../types/auth';

/** Mirrors the backend rules for UX feedback. The server re-validates everything. */

export const GENDER_OPTIONS = [
  { value: 'FEMALE', label: 'Female' },
  { value: 'MALE', label: 'Male' },
  { value: 'OTHER', label: 'Other' },
] as const;

export const BLOOD_GROUP_OPTIONS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'UNKNOWN'].map((v) => ({
  value: v,
  label: v === 'UNKNOWN' ? 'Not known' : v,
}));

export interface RegistrationForm {
  fullName: string;
  email: string;
  mobile: string;
  password: string;
  confirmPassword: string;
  dob: string;
  gender: string;
  bloodGroup: string;
  addressLine: string;
  city: string;
  state: string;
  pincode: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  consent: boolean;
}

export const EMPTY_REGISTRATION: RegistrationForm = {
  fullName: '',
  email: '',
  mobile: '',
  password: '',
  confirmPassword: '',
  dob: '',
  gender: '',
  bloodGroup: '',
  addressLine: '',
  city: '',
  state: '',
  pincode: '',
  emergencyContactName: '',
  emergencyContactPhone: '',
  consent: false,
};

export type FormField = keyof RegistrationForm;
export type FieldErrors = Partial<Record<FormField, string>>;

export const STEPS: { title: string; hint: string; fields: FormField[] }[] = [
  {
    title: 'Account',
    hint: 'How you sign in',
    fields: ['fullName', 'email', 'mobile', 'password', 'confirmPassword'],
  },
  {
    title: 'About you',
    hint: 'Personal and address details',
    fields: ['dob', 'gender', 'bloodGroup', 'addressLine', 'city', 'state', 'pincode'],
  },
  {
    title: 'Safety & consent',
    hint: 'Emergency contact and data consent',
    fields: ['emergencyContactName', 'emergencyContactPhone', 'consent'],
  },
];

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
  if (!/[a-z]/.test(password)) issues.push('a lowercase letter');
  if (!/[A-Z]/.test(password)) issues.push('an uppercase letter');
  if (!/\d/.test(password)) issues.push('a digit');
  if (!/[^A-Za-z0-9]/.test(password)) issues.push('a special character');
  return issues;
}

function isValidDob(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return false;
  return d <= new Date();
}

export function validateForm(form: RegistrationForm): FieldErrors {
  const e: FieldErrors = {};
  const name = form.fullName.trim();
  if (name.length < 2) e.fullName = 'Enter your full name';

  const email = form.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) e.email = 'Enter a valid email address';

  if (!normalizeMobile(form.mobile)) e.mobile = 'Enter a valid 10-digit Indian mobile number';

  const issues = passwordIssues(form.password);
  if (form.password.length > 128) issues.push('at most 128 characters');
  if (issues.length) e.password = `Password needs ${issues.join(', ')}`;
  if (form.confirmPassword !== form.password) e.confirmPassword = 'Passwords do not match';

  if (!isValidDob(form.dob)) e.dob = 'Enter a valid date of birth (not in the future)';
  if (!GENDER_OPTIONS.some((g) => g.value === form.gender)) e.gender = 'Select a gender';
  if (!BLOOD_GROUP_OPTIONS.some((b) => b.value === form.bloodGroup)) e.bloodGroup = 'Select a blood group';

  if (form.addressLine.trim().length < 5) e.addressLine = 'Enter your address';
  if (form.city.trim().length < 2) e.city = 'Enter your city';
  if (form.state.trim().length < 2) e.state = 'Enter your state';
  if (!/^\d{6}$/.test(form.pincode.trim())) e.pincode = 'Pincode must be 6 digits';

  if (form.emergencyContactName.trim().length < 2) e.emergencyContactName = 'Enter an emergency contact name';
  if (!normalizeMobile(form.emergencyContactPhone)) e.emergencyContactPhone = 'Enter a valid 10-digit mobile number';

  if (!form.consent) e.consent = 'Consent is required to store and share your health data';
  return e;
}

export function validateStep(form: RegistrationForm, step: number): FieldErrors {
  const all = validateForm(form);
  const fields = STEPS[step]?.fields ?? [];
  const scoped: FieldErrors = {};
  for (const f of fields) if (all[f]) scoped[f] = all[f];
  return scoped;
}

export function stepOfField(field: string): number {
  const idx = STEPS.findIndex((s) => s.fields.includes(field as FormField));
  return idx === -1 ? 0 : idx;
}

/** Builds the request body. There is deliberately no role here; the server would ignore it anyway. */
export function toPayload(form: RegistrationForm): RegistrationPayload {
  return {
    fullName: form.fullName.trim(),
    email: form.email.trim().toLowerCase(),
    mobile: normalizeMobile(form.mobile) ?? form.mobile.trim(),
    password: form.password,
    dob: form.dob,
    gender: form.gender as RegistrationPayload['gender'],
    bloodGroup: form.bloodGroup as RegistrationPayload['bloodGroup'],
    addressLine: form.addressLine.trim(),
    city: form.city.trim(),
    state: form.state.trim(),
    pincode: form.pincode.trim(),
    emergencyContactName: form.emergencyContactName.trim(),
    emergencyContactPhone: normalizeMobile(form.emergencyContactPhone) ?? form.emergencyContactPhone.trim(),
    consent: true,
  };
}
