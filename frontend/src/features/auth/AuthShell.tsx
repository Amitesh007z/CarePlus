import type { ReactNode } from 'react';
import { CalendarCheck, HeartPulse, ShieldCheck, Pill } from 'lucide-react';

interface AuthShellProps {
  title: string;
  subtitle: string;
  footer?: ReactNode;
  children: ReactNode;
}

const PILLARS = [
  { icon: CalendarCheck, text: 'Book doctor visits in a few taps' },
  { icon: Pill, text: 'Order exactly what your prescription says' },
  { icon: ShieldCheck, text: 'Your health data stays private and consented' },
];

/** Split layout: brand story on wide screens, form card always. */
export function AuthShell({ title, subtitle, footer, children }: AuthShellProps) {
  return (
    <div className="mx-auto grid max-w-5xl items-center gap-10 lg:grid-cols-2">
      <aside className="relative hidden overflow-hidden rounded-3xl bg-gradient-to-br from-teal-600 via-emerald-500 to-cyan-500 p-10 text-white shadow-2xl shadow-teal-700/25 lg:block">
        <div aria-hidden="true" className="absolute -right-16 -top-16 size-64 rounded-full bg-white/15 blur-2xl" />
        <div aria-hidden="true" className="absolute -bottom-20 -left-10 size-72 rounded-full bg-amber-300/25 blur-3xl" />
        <div className="relative">
          <span className="grid size-12 place-items-center rounded-2xl bg-white/20 ring-1 ring-white/30">
            <HeartPulse className="size-6" aria-hidden="true" />
          </span>
          <h2 className="mt-8 text-3xl font-bold leading-tight tracking-tight">Care that flows from consult to doorstep.</h2>
          <p className="mt-3 text-sm text-teal-50/90">
            One account for appointments, prescriptions and medicine orders. Fictional demo with synthetic data.
          </p>
          <ul className="mt-10 space-y-4">
            {PILLARS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-sm font-medium">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/20">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <section className="rounded-3xl border border-white/70 bg-white/90 p-6 shadow-[0_20px_60px_-20px_rgba(15,42,46,0.25)] ring-1 ring-slate-900/5 backdrop-blur sm:p-10">
        <h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1>
        <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p>
        <div className="mt-7">{children}</div>
        {footer && <p className="mt-8 text-center text-sm text-slate-600">{footer}</p>}
      </section>
    </div>
  );
}
