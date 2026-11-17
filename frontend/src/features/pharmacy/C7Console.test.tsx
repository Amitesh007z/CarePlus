import { configure, screen, within } from '@testing-library/react';
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

const placedOrder = {
  id: 'o-1',
  orderNumber: 'ORD-2026-000010',
  status: 'PLACED',
  isPrescriptionOrder: false,
  placedAt: '2026-11-17T04:00:00.000Z',
  items: [
    { lineNo: 1, name: 'Paracetamol 650 mg tablet', sku: 'MED-1006', strength: '650 mg', packSize: 'Strip of 15', unitPriceInr: 32, quantity: 2, lineTotalInr: 64, rxRequired: false, prescriptionRxNumber: null },
  ],
  subtotalInr: 64,
  discountInr: 0,
  deliveryFeeInr: 40,
  totalInr: 104,
  paymentMethod: 'COD',
  paymentStatus: 'PENDING',
  address: { label: 'Home', line: '14 Test Lane', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' },
  timeline: { placedAt: '2026-11-17T04:00:00.000Z', verifiedAt: null, packedAt: null, dispatchedAt: null, deliveredAt: null, rejectedAt: null, cancelledAt: null },
  statusReason: null,
  explanation: [],
  patient: { name: 'Anita Rao' },
  prescriptions: [],
  events: [],
};

const stockRows = {
  items: [{ id: 'm-1', sku: 'MED-1006', name: 'Paracetamol 650 mg tablet', stockOnHand: 4, active: true, availability: 'LOW_STOCK' }],
  meta: { page: 1, pageSize: 50, total: 1, totalPages: 1 },
  lowStockThreshold: 10,
};

// Lazy route chunks load slower than the 1s default; give async queries room.
configure({ asyncUtilTimeout: 5000 });

describe('pharmacist console (C7)', () => {
  it('dashboard tiles show the live counts from the summary endpoint', async () => {
    mockApi({
      'GET /api/v1/auth/me': () => ok(pharmacistSession),
      // RoleDashboard reads the profile from this same path; the counts ride alongside it in the test.
      'GET /api/v1/pharmacy/dashboard': () => ok({ role: 'PHARMACIST', profile: { displayName: 'Test pharmacist' } }),
      'GET /api/v1/pharmacy/dashboard/summary': () => ok({ awaitingVerification: 3, inProgress: 2, deliveredToday: 5, rejectedToday: 1, lowStockItems: 4, outOfStockItems: 1, lowStockThreshold: 10 }),
    });
    renderAt('/pharmacy/dashboard');

    expect(await screen.findByText('3 orders to check.')).toBeInTheDocument();
    expect(screen.getByText('Awaiting verification')).toBeInTheDocument();
    expect(screen.getByText('4 at or below 10 units.')).toBeInTheDocument();
  });

  it('the reject dialog blocks submit with an empty reason and sends nothing', async () => {
    const calls = mockApi({
      'GET /api/v1/auth/me': () => ok(pharmacistSession),
      'GET /api/v1/pharmacy/orders/o-1': () => ok(placedOrder),
    });
    renderAt('/pharmacy/orders/o-1');

    await userEvent.click(await screen.findByRole('button', { name: 'Reject order' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject order' }));

    expect(await within(dialog).findByText('Give a reason of at least 3 characters')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('the adjust dialog blocks a zero change and asks for a reason; nothing is sent', async () => {
    const calls = mockApi({
      'GET /api/v1/auth/me': () => ok(pharmacistSession),
      'GET /api/v1/pharmacy/stock': () => ok(stockRows),
      'GET /api/v1/pharmacy/medicines/m-1/movements': () => ok({ items: [] }),
    });
    renderAt('/pharmacy/stock');

    await userEvent.click(await screen.findByRole('button', { name: 'Adjust' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Change in units'), '0');
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Count correction');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save adjustment' }));

    expect(await within(dialog).findByText(/Enter a whole number of units/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('the prescription review never shows diagnosis or advice, even if the server sends them', async () => {
    mockApi({
      'GET /api/v1/auth/me': () => ok(pharmacistSession),
      'GET /api/v1/pharmacy/prescriptions/rx-1': () =>
        ok({
          id: 'rx-1',
          rxNumber: 'CP-2026-000023',
          status: 'ISSUED',
          validTill: '2026-12-17',
          issuedAt: '2026-11-17T04:00:00.000Z',
          patient: { name: 'Anita Rao', age: 35 },
          doctor: { name: 'Dr. Mehta', specialty: 'General Physician', registrationNo: 'SYN-REG-0001' },
          items: [{ lineNo: 1, medicineId: 'm-1', name: 'Azithromycin 500 mg tablet', strength: '500 mg', dose: '500 mg', frequency: 'Once a day', durationDays: 3, quantity: 3 }],
          checks: { allergyConflicts: [], majorInteractions: [] },
          diagnosisDescription: 'SECRET DIAGNOSIS',
          advice: 'SECRET ADVICE',
          examinationNotes: 'SECRET NOTES',
        }),
    });
    renderAt('/pharmacy/prescriptions/rx-1');

    expect(await screen.findByText('Azithromycin 500 mg tablet')).toBeInTheDocument();
    expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
