import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiRequest, setCsrfToken } from '../lib/api';
import { AuthContext, type AuthValue } from '../lib/auth-context';
import type { SessionPayload, SessionUser } from '../types/auth';

/** Owns session state. The cookie is HttpOnly, so the browser never exposes the session itself. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthValue['status']>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);

  const adopt = useCallback((session: SessionPayload): SessionUser => {
    setCsrfToken(session.csrfToken);
    setUser(session.user);
    setStatus('authenticated');
    return session.user;
  }, []);

  const clear = useCallback(() => {
    setCsrfToken(null);
    setUser(null);
    setStatus('anonymous');
  }, []);

  // Session restoration on page load/refresh.
  useEffect(() => {
    const controller = new AbortController();
    apiRequest<SessionPayload>('/api/v1/auth/me', { signal: controller.signal })
      .then(adopt)
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        clear(); // 401 (no/expired session) or API unreachable: treat as signed out
      });
    return () => controller.abort();
  }, [adopt, clear]);

  const login = useCallback<AuthValue['login']>(
    async (identifier, password) => {
      const session = await apiRequest<SessionPayload>('/api/v1/auth/login', {
        method: 'POST',
        body: { identifier, password },
      });
      return adopt(session);
    },
    [adopt],
  );

  const register = useCallback<AuthValue['register']>(
    async (values) => {
      const session = await apiRequest<SessionPayload>('/api/v1/auth/register', { method: 'POST', body: values });
      return adopt(session);
    },
    [adopt],
  );

  const logout = useCallback<AuthValue['logout']>(async () => {
    try {
      await apiRequest('/api/v1/auth/logout', { method: 'POST' });
    } finally {
      clear(); // local state is always cleared; errors still propagate to the caller
    }
  }, [clear]);

  const refresh = useCallback<AuthValue['refresh']>(async () => {
    try {
      adopt(await apiRequest<SessionPayload>('/api/v1/auth/me'));
    } catch {
      clear();
    }
  }, [adopt, clear]);

  const value = useMemo<AuthValue>(
    () => ({ status, user, login, register, logout, refresh }),
    [status, user, login, register, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
