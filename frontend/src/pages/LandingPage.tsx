import { Link, Navigate } from 'react-router-dom';
import { CalendarDays, Pill, ShieldCheck, Stethoscope } from 'lucide-react';
import { PageLoader } from '../components/PageLoader';
import { Button } from '../components/ui/Button';
import { ApiStatusCard } from '../features/status/ApiStatusCard';
import { useAuth } from '../lib/auth-context';
import { ROLE_META } from '../types/auth';

const ROLE_CARDS = [
  { icon: CalendarDays, title: 'Patients', text: 'Book visits, keep your health profile, and order what your prescription says.', tone: 'bg-teal-100 text-teal-700' },
  { icon: Stethoscope, title: 'Doctors', text: 'Review your patients, record consultations and issue prescriptions.', tone: 'bg-indigo-100 text-indigo-700' },
  { icon: Pill, title: 'Pharmacists', text: 'Verify prescription orders and keep fulfilment and stock moving.', tone: 'bg-emerald-100 text-emerald-700' },
  { icon: ShieldCheck, title: 'Admins', text: 'Manage staff accounts, the catalogue and approved knowledge.', tone: 'bg-amber-100 text-amber-800' },
] as const;

export default function LandingPage() {
  const { status, user } = useAuth();
  if (status === 'loading') return <PageLoader label="Restoring your session" />;
  if (status === 'authenticated' && user) return <Navigate to={ROLE_META[user.role].dashboardPath} replace />;

  return (
    <div className="space-y-16">
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-teal-600 via-emerald-500 to-cyan-500 px-7 py-14 text-white shadow-2xl shadow-teal-700/25 sm:px-14 sm:py-20">
        <div aria-hidden="true" className="absolute -right-24 -top-24 size-96 rounded-full bg-white/15 blur-3xl" />
        <div aria-hidden="true" className="absolute -bottom-32 left-10 size-96 rounded-full bg-amber-300/25 blur-3xl" />
        <div className="relative max-w-2xl">
          <p className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold ring-1 ring-white/30">
            Fictional demo · synthetic data
          </p>
          <h1 className="mt-6 text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl">
            From consultation to doorstep, without the paperwork.
          </h1>
          <p className="mt-5 max-w-xl text-base text-teal-50/95 sm:text-lg">
            CarePulse connects appointments, digital prescriptions and medicine orders. Allergies and prescription rules are checked before anything is ordered.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link to="/register" className="inline-flex min-h-11 items-center rounded-xl bg-white px-6 text-sm font-semibold text-teal-800 shadow-lg shadow-black/10 transition hover:bg-teal-50">
              Create patient account
            </Link>
            <Link to="/login" className="inline-flex min-h-11 items-center rounded-xl bg-white/15 px-6 text-sm font-semibold text-white ring-1 ring-white/40 backdrop-blur transition hover:bg-white/25">
              Sign in
            </Link>
          </div>
        </div>
      </section>

      <section aria-labelledby="roles-heading" className="space-y-6">
        <div>
          <h2 id="roles-heading" className="text-2xl font-bold tracking-tight text-ink">
            One platform, four workspaces
          </h2>
          <p className="mt-1 text-slate-600">Each role sees only what it needs. Staff accounts are created by an administrator.</p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {ROLE_CARDS.map(({ icon: Icon, title, text, tone }) => (
            <article key={title} className="rounded-2xl border border-white/70 bg-white/85 p-6 shadow-sm ring-1 ring-slate-900/5 transition duration-300 hover:-translate-y-1 hover:shadow-xl">
              <span className={`grid size-12 place-items-center rounded-2xl ${tone}`}>
                <Icon className="size-6" aria-hidden="true" />
              </span>
              <h3 className="mt-5 text-lg font-semibold text-ink">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="grid items-center gap-6 md:grid-cols-2">
        <div className="space-y-4">
          <h2 className="text-2xl font-bold tracking-tight text-ink">Built for safety first</h2>
          <p className="text-slate-600">
            Sessions live on the server, staff roles are never self-assigned, and every protected action is checked on the server, not just in the browser.
          </p>
          <Link to="/register">
            <Button variant="secondary">Start with a patient account</Button>
          </Link>
        </div>
        <div className="max-w-md md:justify-self-end md:w-full">
          <ApiStatusCard />
        </div>
      </section>
    </div>
  );
}
