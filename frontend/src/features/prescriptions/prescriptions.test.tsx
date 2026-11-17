import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, ok, patientSession, renderAt } from '../../test/apiMock';
import type { Prescription } from './types';

const doctorSession = {
  user: {
    id: 'doc-1', role: 'DOCTOR', email: 'dr.mehta@example.com', mobile: '9876500003', emailVerified: true,
    displayName: 'Dr. Mehta', createdAt: '2026-01-01T00:00:00.000Z',
    doctor: { specialty: 'General Physician', registrationNo: 'SYN-1', experienceYears: 12 },
  },
  csrfToken: 'csrf-doc',
};

function rx(overrides: Partial<Prescription> = {}): Prescription {
  return {
    id: 'rx-1', rxNumber: null, status: 'DRAFT', consultationId: 'c-1',
    patient: { id: 'p-1', name: 'Anita Rao', age: 35 },
    doctor: { id: 'doc-1', name: 'Dr. Mehta', specialty: 'General Physician', registrationNo: 'SYN-1' },
    advice: null, issuedAt: null, validTill: null, fulfilledAt: null, replacesId: null, supersededById: null,
    items: [{
      id: 'i-1', lineNo: 1, medicine: { id: 'm-2', sku: 'MED-1002', name: 'Amoxicillin 500 mg capsule', strength: '500 mg' },
      allergyClass: 'Penicillin', dose: '500 mg', frequency: 'Three times a day', durationDays: 5, instructions: null, quantity: 15,
    }],
    allergyCheck: null,
    checks: { allergyMatches: [], blockers: [], canIssue: true },
    ...overrides,
  };
}

describe('prescriptions', () => {
  it('blocks issuing when a medicine matches a recorded allergy', async () => {
    const conflict = rx({
      checks: {
        allergyMatches: [{ medicineSku: 'MED-1002', medicineName: 'Amoxicillin 500 mg capsule', allergyClass: 'Penicillin', matchedOn: 'ALLERGY_CLASS' }],
        blockers: ['A medicine matches a recorded allergy'],
        canIssue: false,
      },
    });
    const calls = mockApi({
      'GET /api/v1/auth/me': () => ok(doctorSession),
      'GET /api/v1/doctor/prescriptions/rx-1': () => ok(conflict),
    });
    renderAt('/doctor/prescriptions/rx-1/preview');

    expect(await screen.findByText('This prescription cannot be issued yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Issue prescription/ })).toBeDisabled();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('issues after explicit confirmation, then shows the issued number', async () => {
    let issued = false;
    const calls = mockApi({
      'GET /api/v1/auth/me': () => ok(doctorSession),
      'GET /api/v1/doctor/prescriptions/rx-1': () =>
        ok(issued ? rx({ status: 'ISSUED', rxNumber: 'CP-2026-000042', issuedAt: new Date().toISOString(), validTill: '2026-12-17', allergyCheck: { policy: 'BLOCK', matches: [], checkedAt: new Date().toISOString() }, checks: null }) : rx()),
      'POST /api/v1/doctor/prescriptions/rx-1/issue': () => {
        issued = true;
        return ok(rx({ status: 'ISSUED', rxNumber: 'CP-2026-000042', validTill: '2026-12-17' }));
      },
    });
    renderAt('/doctor/prescriptions/rx-1/preview');

    await userEvent.click(await screen.findByRole('button', { name: /Issue prescription/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Issue this prescription?' });
    expect(within(dialog).getByText(/cannot be edited/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Yes, issue' }));

    expect(await screen.findByText('CP-2026-000042')).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/api/v1/doctor/prescriptions/rx-1/issue')).toHaveLength(1);
  });

  it('the patient sees their issued prescriptions by number, and never a draft', async () => {
    mockApi({
      'GET /api/v1/auth/me': () => ok(patientSession),
      'GET /api/v1/patients/me/prescriptions': () =>
        ok({
          items: [{ id: 'rx-9', rxNumber: 'CP-2026-000007', status: 'ISSUED', issuedAt: new Date().toISOString(), validTill: '2026-12-17', doctor: { name: 'Dr. Mehta', specialty: 'General Physician' }, itemCount: 2 }],
          meta: { page: 1, pageSize: 50, total: 1, totalPages: 1 },
          today: '2026-11-17',
        }),
    });
    renderAt('/patient/prescriptions');
    expect(await screen.findByText('CP-2026-000007')).toBeInTheDocument();
    expect(screen.getByText(/2 medicines/)).toBeInTheDocument();
    expect(screen.queryByText(/Draft/)).not.toBeInTheDocument();
  });
});
