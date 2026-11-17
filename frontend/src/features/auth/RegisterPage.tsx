import { useState, type FormEvent, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Navigate, Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth-context';
import { ROLE_META } from '../../types/auth';
import { AuthShell } from './AuthShell';
import {
  BLOOD_GROUP_OPTIONS,
  EMPTY_REGISTRATION,
  GENDER_OPTIONS,
  STEPS,
  stepOfField,
  toPayload,
  validateForm,
  validateStep,
  type FieldErrors,
  type FormField,
  type RegistrationForm,
} from './registration';

const LAST = STEPS.length - 1;

/** Maps server 409/422 detail paths (field names) onto form fields. */
function serverErrors(err: unknown): { errors: FieldErrors; message: string } {
  if (err instanceof ApiError) {
    const errors: FieldErrors = {};
    for (const d of err.details) {
      if (d.path && d.path in EMPTY_REGISTRATION) errors[d.path as FormField] = d.message;
    }
    return { errors, message: err.message };
  }
  return { errors: {}, message: 'Something went wrong. Please try again.' };
}

export default function RegisterPage() {
  const { status, user, register } = useAuth();
  const [form, setForm] = useState<RegistrationForm>(EMPTY_REGISTRATION);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authenticated' && user) return <Navigate to={ROLE_META[user.role].dashboardPath} replace />;

  const set = <K extends keyof RegistrationForm>(key: K, value: RegistrationForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };
  const fieldProps = (key: FormField) => ({ error: errors[key] });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);

    if (step < LAST) {
      const stepErrors = validateStep(form, step);
      setErrors(stepErrors);
      if (Object.keys(stepErrors).length === 0) setStep(step + 1);
      return;
    }

    const all = validateForm(form);
    setErrors(all);
    if (Object.keys(all).length) {
      setStep(stepOfField(Object.keys(all)[0]!));
      return;
    }

    setSubmitting(true);
    try {
      await register(toPayload(form));
    } catch (err) {
      const { errors: serverFieldErrors, message } = serverErrors(err);
      setErrors(serverFieldErrors);
      setFormError(message);
      if (Object.keys(serverFieldErrors).length) setStep(stepOfField(Object.keys(serverFieldErrors)[0]!));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Create your patient account"
      subtitle="Takes about two minutes. You can complete your health profile later."
      footer={
        <>
          Already registered?{' '}
          <Link to="/login" className="font-semibold text-teal-700 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <Stepper current={step} />

      <form onSubmit={onSubmit} noValidate className="mt-7 space-y-5">
        {formError && (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">
            {formError}
          </div>
        )}

        {step === 0 && (
          <Fields>
            <Input label="Full name" autoComplete="name" value={form.fullName} onChange={(e) => set('fullName', e.target.value)} {...fieldProps('fullName')} />
            <Input label="Email" type="email" autoComplete="email" value={form.email} onChange={(e) => set('email', e.target.value)} {...fieldProps('email')} />
            <Input label="Mobile (India)" type="tel" autoComplete="tel" inputMode="tel" value={form.mobile} onChange={(e) => set('mobile', e.target.value)} {...fieldProps('mobile')} hint="10 digits. +91 is optional." />
            <Input label="Password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => set('password', e.target.value)} {...fieldProps('password')} hint="8+ characters with upper, lower, a digit and a symbol." />
            <Input label="Confirm password" type="password" autoComplete="new-password" value={form.confirmPassword} onChange={(e) => set('confirmPassword', e.target.value)} {...fieldProps('confirmPassword')} />
          </Fields>
        )}

        {step === 1 && (
          <Fields>
            <Input label="Date of birth" type="date" value={form.dob} onChange={(e) => set('dob', e.target.value)} {...fieldProps('dob')} />
            <Select label="Gender" placeholder="Select" options={GENDER_OPTIONS} value={form.gender} onChange={(e) => set('gender', e.target.value)} {...fieldProps('gender')} />
            <Select label="Blood group" placeholder="Select" options={BLOOD_GROUP_OPTIONS} value={form.bloodGroup} onChange={(e) => set('bloodGroup', e.target.value)} {...fieldProps('bloodGroup')} />
            <div className="sm:col-span-2">
              <Input label="Address" autoComplete="street-address" value={form.addressLine} onChange={(e) => set('addressLine', e.target.value)} {...fieldProps('addressLine')} />
            </div>
            <Input label="City" autoComplete="address-level2" value={form.city} onChange={(e) => set('city', e.target.value)} {...fieldProps('city')} />
            <Input label="State" autoComplete="address-level1" value={form.state} onChange={(e) => set('state', e.target.value)} {...fieldProps('state')} />
            <Input label="Pincode" inputMode="numeric" autoComplete="postal-code" maxLength={6} value={form.pincode} onChange={(e) => set('pincode', e.target.value)} {...fieldProps('pincode')} />
          </Fields>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <Fields>
              <Input label="Emergency contact name" value={form.emergencyContactName} onChange={(e) => set('emergencyContactName', e.target.value)} {...fieldProps('emergencyContactName')} />
              <Input label="Emergency contact mobile" type="tel" inputMode="tel" value={form.emergencyContactPhone} onChange={(e) => set('emergencyContactPhone', e.target.value)} {...fieldProps('emergencyContactPhone')} />
            </Fields>
            <label className="flex cursor-pointer gap-3 rounded-2xl bg-teal-50/70 p-4 ring-1 ring-teal-100">
              <input
                type="checkbox"
                checked={form.consent}
                onChange={(e) => set('consent', e.target.checked)}
                aria-invalid={errors.consent ? true : undefined}
                className="mt-0.5 size-4 accent-teal-600"
              />
              <span className="text-sm text-slate-700">
                I consent to CarePulse storing my health information. It is shared only with my treating doctors and
                dispensing pharmacy, and I can withdraw consent from my profile at any time.
              </span>
            </label>
            {errors.consent && (
              <p role="alert" className="text-sm font-medium text-rose-600">
                {errors.consent}
              </p>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pt-2">
          <Button variant="secondary" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || submitting}>
            Back
          </Button>
          <Button type="submit" loading={submitting}>
            {step < LAST ? 'Continue' : submitting ? 'Creating account' : 'Create account'}
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}

function Fields({ children }: { children: ReactNode }) {
  return <div className="grid gap-5 sm:grid-cols-2">{children}</div>;
}

function Stepper({ current }: { current: number }) {
  return (
    <ol aria-label="Registration progress" className="grid grid-cols-3 gap-2">
      {STEPS.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={s.title} aria-current={active ? 'step' : undefined} className="space-y-2">
            <div className={`h-1.5 rounded-full transition ${done || active ? 'bg-gradient-to-r from-teal-500 to-emerald-400' : 'bg-slate-200'}`} />
            <p className={`flex items-center gap-1.5 text-xs font-semibold ${active ? 'text-teal-800' : 'text-slate-500'}`}>
              {done && <Check className="size-3.5" aria-hidden="true" />}
              {s.title}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
