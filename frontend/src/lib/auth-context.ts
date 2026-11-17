import { createContext, useContext } from 'react';
import type { RegistrationPayload, SessionUser } from '../types/auth';

export interface AuthValue {
  status: 'loading' | 'authenticated' | 'anonymous';
  user: SessionUser | null;
  login(identifier: string, password: string): Promise<SessionUser>;
  register(values: RegistrationPayload): Promise<SessionUser>;
  logout(): Promise<void>;
  /** Re-reads the server session. Clears local state if the cookie is no longer valid. */
  refresh(): Promise<void>;
}

export const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
