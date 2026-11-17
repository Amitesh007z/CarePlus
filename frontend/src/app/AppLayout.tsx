import { Suspense, useState } from 'react';
import { HeartPulse, LogOut, Menu } from 'lucide-react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { PageLoader } from '../components/PageLoader';
import { Button } from '../components/ui/Button';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../lib/auth-context';
import { ROLE_META, type Role } from '../types/auth';

const NAV: Record<Role, { to: string; label: string }[]> = {
  PATIENT: [
    { to: '/patient/dashboard', label: 'Home' },
    { to: '/doctors', label: 'Doctors' },
    { to: '/appointments', label: 'Appointments' },
    { to: '/patient/visits', label: 'Visits' },
    { to: '/patient/prescriptions', label: 'Prescriptions' },
    { to: '/medicines', label: 'Medicines' },
    { to: '/patient/health', label: 'Health' },
    { to: '/patient/profile', label: 'Profile' },
  ],
  DOCTOR: [{ to: '/doctor/dashboard', label: 'Home' }],
  PHARMACIST: [
    { to: '/pharmacy/dashboard', label: 'Home' },
    { to: '/pharmacy/queue', label: 'Queue' },
    { to: '/pharmacy/stock', label: 'Stock' },
  ],
  ADMIN: [
    { to: '/admin/dashboard', label: 'Home' },
    { to: '/admin/medicines', label: 'Medicines' },
  ],
};

const navLink = ({ isActive }: { isActive: boolean }) =>
  `rounded-xl px-3.5 py-2 text-sm font-medium transition ${
    isActive ? 'bg-white text-teal-800 shadow-sm ring-1 ring-teal-100' : 'text-slate-600 hover:bg-white/70 hover:text-ink'
  }`;

export function AppLayout() {
  const { status, user, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const links = user ? NAV[user.role] : [];

  async function onSignOut() {
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch {
      toast.notify('error', 'Sign-out failed. Please try again.');
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-white/60 bg-white/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-teal-500 to-emerald-500 text-white shadow-md shadow-teal-600/25">
              <HeartPulse className="size-5" aria-hidden="true" />
            </span>
            <span className="text-lg font-bold tracking-tight text-ink">CarePulse</span>
          </Link>

          <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} className={navLink}>{l.label}</NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            {status === 'authenticated' && user ? (
              <>
                <div className="hidden items-center gap-2 lg:flex">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${ROLE_META[user.role].chip}`}>
                    {ROLE_META[user.role].label}
                  </span>
                  <span className="max-w-40 truncate text-sm font-medium text-ink">{user.displayName}</span>
                </div>
                <Button variant="secondary" className="min-h-9 px-3 py-1.5" onClick={onSignOut}>
                  <LogOut className="size-4" aria-hidden="true" />
                  <span>Sign out</span>
                </Button>
              </>
            ) : status === 'anonymous' ? (
              <>
                <Link to="/login" className={navLink({ isActive: false })}>Sign in</Link>
                <Link to="/register" className="rounded-xl bg-gradient-to-r from-teal-600 to-emerald-500 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-teal-600/20">
                  Create account
                </Link>
              </>
            ) : null}
            {links.length > 1 && (
              <button
                type="button"
                className="rounded-xl p-2 text-ink ring-1 ring-slate-200 md:hidden"
                aria-label="Toggle navigation"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((o) => !o)}
              >
                <Menu className="size-5" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        {menuOpen && links.length > 1 && (
          <nav aria-label="Mobile" className="grid gap-1 border-t border-white/60 bg-white/90 px-4 py-3 md:hidden">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} className={navLink} onClick={() => setMenuOpen(false)}>{l.label}</NavLink>
            ))}
          </nav>
        )}
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:py-10">
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </main>

      <footer className="px-4 pb-8 text-center text-xs text-slate-500">
        CarePulse is a fictional demo with synthetic data. It is not medical advice and not a clinical product.
      </footer>
    </div>
  );
}
