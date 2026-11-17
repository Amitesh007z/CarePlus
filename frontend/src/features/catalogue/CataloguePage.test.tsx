import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, NO_SESSION, ok, renderAt } from '../../test/apiMock';

const medicine = {
  id: '00000000-0000-4000-8000-000000000002',
  sku: 'MED-1002',
  name: 'Amoxicillin 500 mg capsule',
  strength: '500 mg',
  form: 'Capsule',
  category: 'Antibiotic',
  packSize: 'Strip of 10',
  priceInr: 96,
  rxRequired: true,
  allergyClass: 'Penicillin',
  description: null,
  manufacturer: null,
  availability: 'IN_STOCK' as const,
};
const meta = { page: 1, pageSize: 12, total: 1, totalPages: 1 };
const base = {
  'GET /api/v1/auth/me': () => NO_SESSION,
  'GET /api/v1/catalogue/categories': () => ok({ items: ['Antibiotic'] }),
  'GET /api/v1/catalogue/medicines': () => ok({ items: [medicine], meta }),
};

describe('public medicine catalogue', () => {
  it('sends one search request after typing settles (debounced)', async () => {
    const calls = mockApi({
      ...base,
      'GET /api/v1/catalogue/search': () => ok({ items: [medicine], meta, engine: 'algolia', degraded: false, truncated: false }),
    });
    renderAt('/medicines');
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Search medicines' }), 'amox');

    expect(await screen.findByText('Amoxicillin 500 mg capsule')).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/v1/catalogue/search')).toHaveLength(1));
    expect(calls.find((c) => c.path === '/api/v1/catalogue/search')?.method).toBe('GET');
  });

  it('says so when live search is degraded, and still shows results', async () => {
    mockApi({
      ...base,
      'GET /api/v1/catalogue/search': () => ok({ items: [medicine], meta, engine: 'postgres', degraded: true, truncated: false }),
    });
    renderAt('/medicines?q=amox');

    expect(await screen.findByText(/Live search is unavailable; showing the standard catalogue/)).toBeInTheDocument();
    expect(screen.getByText('Amoxicillin 500 mg capsule')).toBeInTheDocument();
  });

  it('shows a no-results state with clear-filters and popular medicines', async () => {
    mockApi({
      ...base,
      'GET /api/v1/catalogue/search': () => ok({ items: [], meta: { ...meta, total: 0, totalPages: 1 }, engine: 'algolia', degraded: false, truncated: false }),
    });
    renderAt('/medicines?q=zzzz');

    expect(await screen.findByText('No medicines match these filters')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /clear filters/i }).length).toBeGreaterThan(0);
    expect(await screen.findByText('Popular medicines')).toBeInTheDocument();
  });
});
