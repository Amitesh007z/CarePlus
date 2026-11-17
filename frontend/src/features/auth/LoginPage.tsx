import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth-context';
import { ROLE_META } from '../../types/auth';
import { AuthShell } from './AuthShell';

/**
 * Local demo accounts shown only in dev builds. Accounts without a `password` use a
 * different secret (the pharmacist's SEED_PHARMACIST_PASSWORD from backend/.env), so the
 * password is left blank for the user to type. Never hard-code that secret here.
 */
const DEMO_ACCOUNTS: { label: string; email: string; password?: string }[] = [
  { label: 'Patient · Anita', email: 'anita.rao@example.com', password: 'Demo@1234' },
  { label: 'Patient · Vikram', email: 'vikram.s@example.com', password: 'Demo@1234' },
  { label: 'Doctor · Dr. Mehta', email: 'dr.mehta@example.com', password: 'Demo@1234' },
  { label: 'Pharmacist', email: 'pharmacist@example.com' },
  { label: 'Admin', email: 'admin@example.com', password: 'Demo@1234' },
];

interface LoginErrors {
  identifier?: string;
  password?: string;
}

/** Server messages are already generic for bad credentials; only rate/network cases get extra wording. */
function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
    return err.message;
  }
  return 'Something went wrong. Please try again.';
}

export default function LoginPage() {
  const { status, user, login } = useAuth();
  const location = useLocation();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<LoginErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authenticated' && user) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? ROLE_META[user.role].dashboardPath} replace />;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const errors: LoginErrors = {};
    if (!identifier.trim()) errors.identifier = 'Enter your email or mobile number';
    if (!password) errors.password = 'Enter your password';
    setFieldErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length) return;

    setSubmitting(true);
    try {
      await login(identifier.trim(), password);
    } catch (err) {
      setFormError(loginErrorMessage(err));
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in with your email or mobile number."
      footer={
        <>
          New to CarePulse?{' '}
          <Link to="/register" className="font-semibold text-teal-700 hover:underline">
            Create a patient account
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        {formError && (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">
            {formError}
          </div>
        )}
        <Input
          label="Email or mobile"
          name="identifier"
          autoComplete="username"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          error={fieldErrors.identifier}
          placeholder="you@example.com or 98765 43210"
        />
        <Input
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
        />
        <Button type="submit" loading={submitting} className="w-full">
          {submitting ? 'Signing in' : 'Sign in'}
        </Button>
      </form>

      {import.meta.env.DEV && (
        <div className="mt-8 rounded-2xl border border-dashed border-teal-200 bg-teal-50/60 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-teal-800">Local demo accounts (synthetic)</p>
          <p className="mt-1 text-xs text-slate-500">
            The pharmacist password is the SEED_PHARMACIST_PASSWORD value in backend/.env. Type it in yourself.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {DEMO_ACCOUNTS.map((a) => (
              <button
                key={a.email}
                type="button"
                onClick={() => {
                  setIdentifier(a.email);
                  setPassword(a.password ?? '');
                  setFieldErrors({});
                  setFormError(null);
                }}
                className="rounded-lg bg-white px-3 py-2 text-left text-xs text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:ring-teal-300"
              >
                <span className="block font-semibold text-ink">{a.label}</span>
                <span className="block truncate text-slate-500">{a.email}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </AuthShell>
  );
}
