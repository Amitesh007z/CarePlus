import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../app/routes';
import { AuthProvider } from '../../app/AuthProvider';
import { ToastProvider } from '../../components/ui/Toast';
import type { SessionUser } from '../../types/auth';

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}
type Reply = [status: number, body: unknown];
type Routes = Record<string, (call: Call) => Reply>;

const ok = (data: unknown): Reply => [200, { success: true, data, requestId: 'req-1' }];
const created = (data: unknown): Reply => [201, { success: true, data, requestId: 'req-1' }];
const fail = (status: number, code: string, message: string, details: unknown[] = []): Reply => [
  status,
  { success: false, error: { code, message, details }, requestId: 'req-1' },
];
const NO_SESSION = fail(401, 'UNAUTHENTICATED', 'Authentication required');

const patient: SessionUser = {
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
const session = (user: SessionUser) => ({ user, csrfToken: 'csrf-abc' });

/** Routes fetch calls by "METHOD /path" and records every call for assertions. */
function mockApi(table: Routes) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
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
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <ToastProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ToastProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('session and route guards', () => {
  it('sends anonymous visitors from a protected dashboard to sign-in', async () => {
    mockApi({ 'GET /api/v1/auth/me': () => NO_SESSION });
    renderAt('/patient/dashboard');
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });

  it('restores the session on refresh and shows the role dashboard', async () => {
    const calls = mockApi({
      'GET /api/v1/auth/me': () => ok(session(patient)),
      'GET /api/v1/patient/dashboard': () => ok({ role: 'PATIENT', profile: patient }),
    });
    renderAt('/patient/dashboard');
    expect(await screen.findByRole('heading', { name: 'Hello, Anita' })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/v1/auth/login')).toBe(false);
  });

  it('keeps a patient out of the doctor dashboard and never calls the doctor API', async () => {
    const calls = mockApi({
      'GET /api/v1/auth/me': () => ok(session(patient)),
      'GET /api/v1/patient/dashboard': () => ok({ role: 'PATIENT', profile: patient }),
    });
    renderAt('/doctor/dashboard');
    expect(await screen.findByRole('heading', { name: 'Hello, Anita' })).toBeInTheDocument();
    expect(calls.map((c) => c.path)).not.toContain('/api/v1/doctor/dashboard');
  });
});

describe('login', () => {
  it('shows one generic message for wrong credentials and clears the password', async () => {
    const calls = mockApi({
      'GET /api/v1/auth/me': () => NO_SESSION,
      'POST /api/v1/auth/login': () => fail(401, 'INVALID_CREDENTIALS', 'Incorrect email/mobile or password'),
    });
    renderAt('/login');
    await userEvent.type(await screen.findByLabelText('Email or mobile'), 'anita.rao@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Wrong@1234');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email/mobile or password');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    const login = calls.find((c) => c.path === '/api/v1/auth/login')!;
    expect(login.body).toEqual({ identifier: 'anita.rao@example.com', password: 'Wrong@1234' });
    expect(login.body).not.toHaveProperty('role');
  });

  it('validates empty fields without a network call', async () => {
    const calls = mockApi({ 'GET /api/v1/auth/me': () => NO_SESSION });
    renderAt('/login');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter your email or mobile number')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('registration', () => {
  it('validates the first step before any network call', async () => {
    const calls = mockApi({ 'GET /api/v1/auth/me': () => NO_SESSION });
    renderAt('/register');
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Enter your full name')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('submits a patient payload with no role and lands on the patient dashboard', async () => {
    const calls = mockApi({
      'GET /api/v1/auth/me': () => NO_SESSION,
      'POST /api/v1/auth/register': () => created(session(patient)),
      'GET /api/v1/patient/dashboard': () => ok({ role: 'PATIENT', profile: patient }),
    });
    renderAt('/register');

    await userEvent.type(await screen.findByLabelText('Full name'), 'Anita Rao');
    await userEvent.type(screen.getByLabelText('Email'), 'Anita.Rao@Example.com');
    await userEvent.type(screen.getByLabelText('Mobile (India)'), '+91 98765 00001');
    await userEvent.type(screen.getByLabelText('Password'), 'Demo@1234');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'Demo@1234');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    fireEvent.change(await screen.findByLabelText('Date of birth'), { target: { value: '1991-04-12' } });
    await userEvent.selectOptions(screen.getByLabelText('Gender'), 'FEMALE');
    await userEvent.selectOptions(screen.getByLabelText('Blood group'), 'B+');
    await userEvent.type(screen.getByLabelText('Address'), '14 Lakeview Residency');
    await userEvent.type(screen.getByLabelText('City'), 'Bengaluru');
    await userEvent.type(screen.getByLabelText('State'), 'Karnataka');
    await userEvent.type(screen.getByLabelText('Pincode'), '560038');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await userEvent.type(await screen.findByLabelText('Emergency contact name'), 'Suresh Rao');
    await userEvent.type(screen.getByLabelText('Emergency contact mobile'), '9876500101');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('heading', { name: 'Hello, Anita' })).toBeInTheDocument();
    const reg = calls.find((c) => c.path === '/api/v1/auth/register')!;
    expect(reg.body).not.toHaveProperty('role');
    expect(reg.body).toMatchObject({ email: 'anita.rao@example.com', mobile: '9876500001', consent: true, pincode: '560038' });
  });

  it('maps a duplicate-email response onto the Account step', async () => {
    mockApi({
      'GET /api/v1/auth/me': () => NO_SESSION,
      'POST /api/v1/auth/register': () =>
        fail(409, 'CONFLICT', 'An account with these details already exists', [
          { path: 'email', message: 'This email is already registered' },
        ]),
    });
    renderAt('/register');
    await userEvent.type(await screen.findByLabelText('Full name'), 'Anita Rao');
    await userEvent.type(screen.getByLabelText('Email'), 'anita.rao@example.com');
    await userEvent.type(screen.getByLabelText('Mobile (India)'), '9876500001');
    await userEvent.type(screen.getByLabelText('Password'), 'Demo@1234');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'Demo@1234');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('Date of birth'), { target: { value: '1991-04-12' } });
    await userEvent.selectOptions(screen.getByLabelText('Gender'), 'FEMALE');
    await userEvent.selectOptions(screen.getByLabelText('Blood group'), 'B+');
    await userEvent.type(screen.getByLabelText('Address'), '14 Lakeview Residency');
    await userEvent.type(screen.getByLabelText('City'), 'Bengaluru');
    await userEvent.type(screen.getByLabelText('State'), 'Karnataka');
    await userEvent.type(screen.getByLabelText('Pincode'), '560038');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.type(await screen.findByLabelText('Emergency contact name'), 'Suresh Rao');
    await userEvent.type(screen.getByLabelText('Emergency contact mobile'), '9876500101');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('This email is already registered')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('logout', () => {
  it('sends the CSRF token, clears the session and returns to sign-in', async () => {
    const calls = mockApi({
      'GET /api/v1/auth/me': () => ok(session(patient)),
      'GET /api/v1/patient/dashboard': () => ok({ role: 'PATIENT', profile: patient }),
      'POST /api/v1/auth/logout': () => ok({ loggedOut: true }),
    });
    renderAt('/patient/dashboard');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    const logout = calls.find((c) => c.path === '/api/v1/auth/logout')!;
    expect(logout.headers['X-CSRF-Token']).toBe('csrf-abc');
  });
});
