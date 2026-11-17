import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, apiRequest } from '../../lib/api';
import { useAuth } from '../../lib/auth-context';
import { PageLoader } from '../../components/PageLoader';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import type { LucideIcon } from 'lucide-react';
import { ROLE_META, type Role, type SessionUser } from '../../types/auth';

interface DashboardResponse {
  role: Role;
  profile: SessionUser | null;
}

type LoadState = { phase: 'loading' } | { phase: 'ready'; user: SessionUser } | { phase: 'error'; message: string };

/**
 * Fetches the role's dashboard from the API. The server checks the role and returns only the
 * caller's own profile, so this component never trusts the client-side guard on its own.
 */
export function RoleDashboard({ path, role, children }: { path: string; role: Role; children: (user: SessionUser) => ReactNode }) {
  const { refresh } = useAuth();
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    apiRequest<DashboardResponse>(`/api/v1${path}`, { signal: controller.signal })
      .then((data) => {
        if (data.profile) setState({ phase: 'ready', user: data.profile });
        else setState({ phase: 'error', message: 'We could not find your profile. Please sign in again.' });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof ApiError && err.status === 401) {
          void refresh(); // session expired: the guard will send the user to sign-in
          return;
        }
        setState({ phase: 'error', message: err instanceof Error ? err.message : 'Could not load your dashboard.' });
      });
    return () => controller.abort();
  }, [path, attempt, refresh]);

  if (state.phase === 'loading') return <PageLoader label={`Loading ${ROLE_META[role].label.toLowerCase()} dashboard`} />;
  if (state.phase === 'error') {
    return (
      <Card className="mx-auto max-w-lg text-center">
        <p role="alert" className="text-sm font-medium text-rose-700">
          {state.message}
        </p>
        <Button className="mt-4" variant="secondary" onClick={() => setAttempt((a) => a + 1)}>
          Try again
        </Button>
      </Card>
    );
  }
  return <>{children(state.user)}</>;
}

export function Hero({ role, title, subtitle, chips = [] }: { role: Role; title: string; subtitle: string; chips?: string[] }) {
  return (
    <section className={`relative overflow-hidden rounded-3xl p-7 text-white shadow-xl shadow-slate-900/10 sm:p-10 ${ROLE_META[role].hero}`}>
      <div aria-hidden="true" className="absolute -right-10 -top-10 size-56 rounded-full bg-white/15 blur-2xl" />
      <div aria-hidden="true" className="absolute bottom-0 left-1/3 size-40 rounded-full bg-white/10 blur-xl" />
      <p className="relative text-xs font-semibold uppercase tracking-[0.18em] text-white/80">{ROLE_META[role].label} workspace</p>
      <h1 className="relative mt-2 text-3xl font-bold tracking-tight sm:text-4xl">{title}</h1>
      <p className="relative mt-2 max-w-2xl text-sm text-white/90 sm:text-base">{subtitle}</p>
      {chips.length > 0 && (
        <ul className="relative mt-6 flex flex-wrap gap-2">
          {chips.map((c) => (
            <li key={c} className="rounded-full bg-white/20 px-3 py-1 text-xs font-semibold ring-1 ring-white/30 backdrop-blur">
              {c}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const TILE_TONES = {
  teal: 'bg-teal-100 text-teal-700',
  indigo: 'bg-indigo-100 text-indigo-700',
  emerald: 'bg-emerald-100 text-emerald-700',
  amber: 'bg-amber-100 text-amber-800',
  rose: 'bg-rose-100 text-rose-700',
} as const;

/** A module that is not built yet. Labelled honestly so the shell never pretends to have data. */
export function ModuleTile({ icon: Icon, title, text, checkpoint, tone }: { icon: LucideIcon; title: string; text: string; checkpoint: string; tone: keyof typeof TILE_TONES }) {
  return (
    <div className="group flex flex-col rounded-2xl border border-white/70 bg-white/85 p-5 shadow-sm ring-1 ring-slate-900/5 transition duration-300 hover:-translate-y-0.5 hover:shadow-lg">
      <span className={`grid size-11 place-items-center rounded-xl ${TILE_TONES[tone]}`}>
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <h3 className="mt-4 font-semibold text-ink">{title}</h3>
      <p className="mt-1 flex-1 text-sm text-slate-500">{text}</p>
      <span className="mt-4 inline-flex w-fit rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">{checkpoint}</span>
    </div>
  );
}

export function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="text-sm font-medium text-ink">{value || <span className="text-slate-400">Not provided</span>}</dd>
    </div>
  );
}
