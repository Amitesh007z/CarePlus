import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, ok, renderAt } from '../../test/apiMock';

const pharmacistSession = {
  user: {
    id: 'u-9',
    role: 'PHARMACIST',
    email: 'pharmacist@example.com',
    mobile: '9876500005',
    emailVerified: true,
    displayName: 'CarePulse Pharmacy',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  csrfToken: 'csrf-abc',
};

const queued = {
  id: 'f-1',
  status: 'QUEUED',
  prescription: {
    id: 'rx-1',
    rxNumber: 'CP-2026-000023',
    status: 'ISSUED',
    validTill: '2026-12-17',
    patient: { name: 'Anita Rao', dob: '1991-04-12' },
    doctor: { name: 'Dr. Mehta', registrationNo: 'SYN-REG-0001' },
  },
  items: [
    {
      lineNo: 1,
      medicineId: 'm-1',
      name: 'Azithromycin 500 mg tablet',
      strength: '500 mg',
      dose: '500 mg',
      frequency: 'Once a day',
      durationDays: 3,
      quantity: 3,
      instructions: null,
      stockOnHand: 100,
      availability: 'IN_STOCK',
    },
  ],
  canPack: true,
  shortfalls: [],
  timeline: { requestedAt: '2026-11-17T04:00:00.000Z', verifiedAt: null, packedAt: null, dispatchedAt: null, deliveredAt: null, rejectedAt: null },
  rejectionReason: null,
};

describe('pharmacist fulfilment', () => {
  it('requires a reason before rejecting, and does not call the API without one', async () => {
    const calls = mockApi({
      'GET /api/v1/auth/me': () => ok(pharmacistSession),
      'GET /api/v1/pharmacy/fulfilments/f-1': () => ok(queued),
    });
    renderAt('/pharmacy/fulfilments/f-1');

    await userEvent.click(await screen.findByRole('button', { name: 'Reject request' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject request' }));

    expect(await within(dialog).findByText('Give a reason of at least 3 characters')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('verify calls the action endpoint with the verify action and shows the next step', async () => {
    const calls = mockApi({
      'GET /api/v1/auth/me': () => ok(pharmacistSession),
      'GET /api/v1/pharmacy/fulfilments/f-1': () => ok(queued),
      'POST /api/v1/pharmacy/fulfilments/f-1/actions': () => ok({ ...queued, status: 'VERIFIED', timeline: { ...queued.timeline, verifiedAt: '2026-11-17T05:00:00.000Z' } }),
    });
    renderAt('/pharmacy/fulfilments/f-1');

    await userEvent.click(await screen.findByRole('button', { name: /Verify prescription/ }));

    expect(await screen.findByRole('button', { name: /Pack and dispense/ })).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/api/v1/pharmacy/fulfilments/f-1/actions');
    expect(post?.body).toEqual({ action: 'verify' });
  });
});
