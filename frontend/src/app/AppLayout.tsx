import { Suspense, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { PageLoader } from '../components/PageLoader';

// Navigation foundation. Role-specific entries are added with the auth checkpoint.
const NAV = [{ to: '/', label: 'Home', end: true }];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-2 text-sm font-medium ${isActive ? 'bg-brand-100 text-brand-700' : 'text-ink hover:bg-slate-100'}`;

export function AppLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <NavLink to="/" className="text-lg font-bold tracking-tight text-brand-600">
            CarePulse
          </NavLink>
          <button
            type="button"
            className="rounded-md p-2 text-ink ring-1 ring-slate-300 md:hidden"
            aria-label="Toggle navigation"
            aria-expanded={menuOpen}
            aria-controls="primary-nav"
            onClick={() => setMenuOpen((o) => !o)}
          >
            ☰
          </button>
          <nav id="primary-nav" aria-label="Primary" className={`${menuOpen ? 'flex' : 'hidden'} absolute inset-x-0 top-14 flex-col gap-1 border-b border-slate-200 bg-white p-3 md:static md:flex md:flex-row md:border-0 md:p-0`}>
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={linkClass} onClick={() => setMenuOpen(false)}>
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </main>
      <footer className="border-t border-slate-200 py-4 text-center text-xs text-slate-500">
        CarePulse is a fictional demo using synthetic data. Not medical advice.
      </footer>
    </div>
  );
}
