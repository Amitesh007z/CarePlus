import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, ok, patientSession, renderAt } from '../../test/apiMock';

const line = (over: Record<string, unknown> = {}) => ({
  id: 'line-1',
  quantity: 2,
  source: 'CATALOGUE',
  locked: false,
  prescription: null,
  medicine: { id: 'med-1', sku: 'MED-1006', name: 'Paracetamol 650 mg tablet', strength: '650 mg', packSize: 'Strip of 15', rxRequired: false, availability: 'IN_STOCK' },
  unitPriceInr: 32,
  lineTotalInr: 64,
  problems: [],
  ...over,
});

const summary = { subtotalInr: 64, discountInr: 0, deliveryFeeInr: 40, totalInr: 104, isPrescriptionOrder: false, freeDelivery: false, explanation: ['Delivery is INR 40 for orders up to INR 299.'] };

const cart = (over: Record<string, unknown> = {}) => ({ items: [line()], summary, blockers: [], ...over });

const address = { id: 'addr-1', label: 'Home', line: '14 Lakeview Residency', city: 'Bengaluru', state: 'Karnataka', pincode: '560038', isDefault: true };

const order = (status: string, over: Record<string, unknown> = {}) => ({
  id: 'order-1',
  orderNumber: 'ORD-2026-000001',
  status,
  isPrescriptionOrder: false,
  placedAt: '2026-11-17T10:00:00.000Z',
  items: [{ lineNo: 1, name: 'Paracetamol 650 mg tablet', sku: 'MED-1006', strength: '650 mg', packSize: 'Strip of 15', unitPriceInr: 32, quantity: 2, lineTotalInr: 64, rxRequired: false, prescriptionRxNumber: null }],
  subtotalInr: 64,
  discountInr: 0,
  deliveryFeeInr: 40,
  totalInr: 104,
  paymentMethod: 'COD',
  paymentStatus: 'PENDING',
  address: { label: 'Home', line: '14 Lakeview Residency', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' },
  timeline: { placedAt: '2026-11-17T10:00:00.000Z', verifiedAt: null, packedAt: null, dispatchedAt: null, deliveredAt: null, rejectedAt: null, cancelledAt: null },
  statusReason: null,
  explanation: ['Delivery is INR 40 for orders up to INR 299.'],
  ...over,
});

describe('cart', () => {
  it('a prescription line cannot change quantity, and checkout stays disabled while the cart has blockers', async () => {
    mockApi({
      'GET /api/v1/auth/me': () => ok(patientSession),
      'GET /api/v1/patients/me/cart': () =>
        ok(
          cart({
            items: [
              line({ id: 'rx-line', source: 'PRESCRIPTION', locked: true, quantity: 3, prescription: { id: 'rx-1', rxNumber: 'CP-2026-000010' }, medicine: { id: 'med-2', sku: 'MED-1002', name: 'Amoxicillin 500 mg capsule', strength: '500 mg', packSize: 'Strip of 10', rxRequired: true, availability: 'IN_STOCK' } }),
            ],
            blockers: ['Amoxicillin 500 mg capsule: a medicine on this order needs a valid prescription'],
          }),
        ),
    });
    renderAt('/cart');

    expect(await screen.findByText(/From prescription CP-2026-000010: quantity is fixed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Increase quantity of Amoxicillin/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Decrease quantity of Amoxicillin/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Checkout' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/needs a valid prescription/);
  });
});

describe('checkout', () => {
  it('a retry after a dropped connection reuses the same Idempotency-Key and does not create a second order', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/v1/auth/me': () => ok(patientSession),
      'GET /api/v1/patients/me/cart': () => ok(cart()),
      'GET /api/v1/patients/me/addresses': () => ok({ items: [address] }),
      'GET /api/v1/patients/me/orders/order-1': () => ok(order('PLACED')),
    });

    // The first placement fails at the network layer; the second succeeds.
    const passThrough = globalThis.fetch;
    const placements: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if ((init?.method ?? 'GET') === 'POST' && path === '/api/v1/patients/me/orders') {
          placements.push((init?.headers as Record<string, string>)['Idempotency-Key'] ?? '');
          if (placements.length === 1) throw new TypeError('Failed to fetch');
          return new Response(JSON.stringify({ success: true, data: order('PLACED'), requestId: 'r' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
        }
        return passThrough(url, init);
      }),
    );

    renderAt('/checkout');
    const place = await screen.findByRole('button', { name: 'Place order' });
    await waitFor(() => expect(place).toBeEnabled());

    await user.click(place);
    expect(await screen.findByText(/connection dropped/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(placements).toHaveLength(2));

    expect(placements[0]).toBeTruthy();
    expect(placements[1]).toBe(placements[0]);
  });
});

describe('order detail', () => {
  it('offers cancel only while the order is PLACED', async () => {
    mockApi({
      'GET /api/v1/auth/me': () => ok(patientSession),
      'GET /api/v1/patients/me/orders/order-1': () => ok(order('VERIFIED', { timeline: { ...order('VERIFIED').timeline, verifiedAt: '2026-11-17T11:00:00.000Z' } })),
    });
    renderAt('/orders/order-1');
    expect(await screen.findByRole('heading', { name: /ORD-2026-000001/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
  });

  it('shows the cancel control for a PLACED order', async () => {
    mockApi({
      'GET /api/v1/auth/me': () => ok(patientSession),
      'GET /api/v1/patients/me/orders/order-1': () => ok(order('PLACED')),
    });
    renderAt('/orders/order-1');
    expect(await screen.findByRole('button', { name: 'Cancel order' })).toBeInTheDocument();
  });
});
