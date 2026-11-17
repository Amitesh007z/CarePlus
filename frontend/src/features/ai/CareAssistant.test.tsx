import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, ok, patientSession, renderAt, type Call } from '../../test/apiMock';
import type { CareResponse } from './types';

const product = {
  id: 'med-otc-1',
  sku: 'MED-1005',
  name: 'Dextromethorphan syrup',
  strength: null,
  form: 'Syrup',
  priceInr: 92,
  availability: 'IN_STOCK',
  rxRequired: false,
  reason: 'Common over-the-counter cough syrup.',
  requiresConfirmation: true,
} as const;

const base: CareResponse = {
  urgency: 'SELF_CARE',
  summary: 'An option from CarePulse for a dry cough.',
  clarificationRequired: false,
  clarificationQuestion: null,
  recommendedDoctors: [],
  recommendedProducts: [],
  safetyMessage: 'If your symptoms get worse, see a doctor.',
  disclaimer: 'Does not diagnose.',
  followUpRequired: false,
};

/** Routes the care endpoint to one canned response and records every call. */
function setup(response: CareResponse) {
  return mockApi({
    'GET /api/v1/auth/me': () => ok(patientSession),
    'POST /api/v1/ai/care/message': () => ok(response),
    'POST /api/v1/patients/me/cart/items': () => ok({ id: 'line-1' }),
  });
}

async function ask(text: string) {
  await userEvent.type(await screen.findByLabelText('Describe what you need'), text);
  await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
}

const cartCalls = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && c.path.includes('/cart/'));

describe('CareAssistantPage (C8)', () => {
  it('emergency state shows guidance and no product cards', async () => {
    // Backend returns zero products for an emergency. The page must hide cards even if any were present.
    const calls = setup({
      ...base,
      urgency: 'EMERGENCY',
      summary: 'Your message may describe an emergency.',
      safetyMessage: 'Some of the details you entered may describe an emergency.',
      recommendedProducts: [product],
      followUpRequired: true,
    });
    renderAt('/care-assistant');
    await ask('Severe chest pain');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Possible emergency. Get help now.');
    expect(alert).toHaveTextContent('Some of the details you entered may describe an emergency.');
    expect(screen.queryByRole('button', { name: /add .* to cart/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Dextromethorphan syrup')).not.toBeInTheDocument();
    expect(screen.queryByText(/Urgency: Self-care/)).not.toBeInTheDocument();
    expect(screen.getByText(/Disclaimer\./)).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/v1/ai/care/message')).toBe(true);
  });

  it('clarification state shows the question and no recommendation cards', async () => {
    setup({
      ...base,
      clarificationRequired: true,
      clarificationQuestion: 'What do you need help with? For example, a symptom.',
      summary: 'More information is needed before suggestions can be made.',
      recommendedProducts: [],
      recommendedDoctors: [],
      followUpRequired: true,
    });
    renderAt('/care-assistant');
    await ask('I feel off');

    expect(await screen.findByText('What do you need help with? For example, a symptom.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add .* to cart/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View doctor and book' })).not.toBeInTheDocument();
  });

  it('add-to-cart needs explicit confirmation before any cart API call', async () => {
    const calls = setup({ ...base, recommendedProducts: [product] });
    renderAt('/care-assistant');
    await ask('dry cough for two days');

    await userEvent.click(await screen.findByRole('button', { name: 'Add Dextromethorphan syrup to cart' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add this item to your cart?' });
    // Opening the dialog is not consent: no cart request yet.
    expect(cartCalls(calls)).toHaveLength(0);

    // "Not now" closes the dialog without any cart request.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(cartCalls(calls)).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Add Dextromethorphan syrup to cart' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Yes, add to cart' }));
    await waitFor(() => expect(cartCalls(calls)).toHaveLength(1));
    expect(cartCalls(calls)[0]!.body).toEqual({ medicineId: 'med-otc-1', quantity: 1 });
  });
});
