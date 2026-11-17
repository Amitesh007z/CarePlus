import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth-context';
import { ROLE_META, type Role } from '../types/auth';
import { PageLoader } from './PageLoader';

/**
 * UX guard only. It hides screens the user should not see; the API enforces the real access rules
 * on every request, so a bypassed guard still gets 401/403 from the server.
 */
export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <PageLoader label="Restoring your session" />;
  if (status === 'anonymous' || !user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (!roles.includes(user.role)) return <Navigate to={ROLE_META[user.role].dashboardPath} replace />;
  return <>{children}</>;
}
