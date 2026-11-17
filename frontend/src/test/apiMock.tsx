/* eslint-disable react-refresh/only-export-components -- test helper module exports data builders and a render helper */
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { vi } from 'vitest';
import { routes } from '../app/routes';
import { AuthProvider } from '../app/AuthProvider';
import { ToastProvider } from '../components/ui/Toast';
import type { SessionUser } from '../types/auth';

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}
export type Reply = [status: number, body: unknown];
export type Routes = Record<string, (call: Call) => Reply>;

export const ok = (data: unknown): Reply => [200, { success: true, data, requestId: 'req-1' }];
export const created = (data: unknown): Reply => [201, { success: true, data, requestId: 'req-1' }];
export const fail = (status: number, code: string, message: string, details: unknown[] = []): Reply => [
  status,
  { success: false, error: { code, message, details }, requestId: 'req-1' },
];
export const NO_SESSION = fail(401, 'UNAUTHENTICATED', 'Authentication required');

export const patientUser: SessionUser = {
  id: 'u-1',
  role: 'PATIENT',
  email: 'anita.rao@example.com',
  mobile: '9876500001',
  emailVerified: true,
  displayName: 'Anita Rao',
  createdAt: '2026-01-01T00:00:00.000Z',
  patient: {
    fullName: 'Anita Rao',
    dob: '1991-04-12',
    age: 35,
    gender: 'FEMALE',
    bloodGroup: 'B+',
    addressLine: '14 Lakeview Residency',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560038',
    emergencyContactName: 'Suresh Rao',
    emergencyContactPhone: '9876500101',
    consentStatus: true,
    consentAt: '2026-01-01T00:00:00.000Z',
  },
};

export const patientSession = { user: patientUser, csrfToken: 'csrf-abc' };

/**
 * Routes fetch calls by "METHOD /path" (query strings are ignored) and records every call.
 * Unknown routes answer 404, so a missing mock fails loudly.
 */
export function mockApi(table: Routes): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? 'GET';
      const call: Call = {
        method,
        path,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      };
      calls.push(call);
      const handler = table[`${method} ${path}`];
      const [status, body] = handler ? handler(call) : fail(404, 'NOT_FOUND', 'Route not found');
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return calls;
}

export function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <ToastProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ToastProvider>,
  );
}

/** A slot `days` ahead at the given IST wall-clock time (HH:MM), as an ISO string. */
export function istIso(days: number, hhmm: string): string {
  const d = new Date(Date.now() + days * 86_400_000);
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const utcMinutes = h * 60 + m - 330;
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + utcMinutes * 60_000).toISOString();
}
