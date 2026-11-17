import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, ok, patientSession, renderAt, type Call } from '../../test/apiMock';
import type { DocDetail, DocView, KnowledgeAnswer } from './types';

const adminSession = {
  user: {
    id: 'u-admin',
    role: 'ADMIN' as const,
    email: 'ops@example.com',
    mobile: null,
    emailVerified: true,
    displayName: 'Ops Admin',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  csrfToken: 'csrf-abc',
};

const source = {
  documentId: 'doc-1',
  chunkId: 'chunk-1',
  title: 'Returns and refunds policy',
  documentType: 'POLICY',
  section: 'Refund timing',
  version: 2,
  effectiveFrom: '2026-01-01',
  score: 0.74,
};

const answered: KnowledgeAnswer = {
  answer: 'Approved refunds reach the original payment method within 7 working days.',
  confidence: 'MEDIUM',
  notCovered: false,
  fallback: false,
  sources: [source],
  followUpRequired: true,
  escalation: null,
};

const notFound: KnowledgeAnswer = {
  answer: "I couldn't find this in CarePulse's approved documents for your access level, so I won't answer from general knowledge.",
  confidence: 'LOW',
  notCovered: true,
  fallback: false,
  sources: [],
  followUpRequired: true,
  escalation: {
    offered: true,
    message: 'Contact CarePulse support, or ask a pharmacist about a medicine question.',
    options: ['SUPPORT', 'PHARMACIST'],
  },
};

describe('Ask CarePulse', () => {
  it('not-found shows the escalation options and no source chips', async () => {
    mockApi({
      'GET /api/v1/auth/me': () => ok(patientSession),
      'POST /api/v1/knowledge/ask': () => ok(notFound),
    });
    renderAt('/ask');
    await userEvent.type(await screen.findByLabelText('Your question'), 'Does CarePulse cover insurance?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));

    expect(await screen.findByText(/won't answer from general knowledge/)).toBeInTheDocument();
    expect(screen.getByText(notFound.escalation!.message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Contact support' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask a pharmacist' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Sources')).not.toBeInTheDocument();
  });

  it('source chips show the title, section and version of the cited passage', async () => {
    mockApi({
      'GET /api/v1/auth/me': () => ok(patientSession),
      'POST /api/v1/knowledge/ask': () => ok(answered),
    });
    renderAt('/ask');
    await userEvent.type(await screen.findByLabelText('Your question'), 'How do refunds work?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));

    const chips = await screen.findByLabelText('Sources');
    expect(within(chips).getByText('Returns and refunds policy')).toBeInTheDocument();
    expect(within(chips).getByText('· Refund timing')).toBeInTheDocument();
    expect(within(chips).getByText('v2')).toBeInTheDocument();
    expect(screen.getByText('Medium confidence', { exact: false })).toBeInTheDocument();
  });
});

const doc = (over: Partial<DocView> = {}): DocView => ({
  id: 'doc-draft',
  slug: 'delivery-policy',
  title: 'Delivery policy',
  documentType: 'POLICY',
  version: 2,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  region: 'IN',
  audience: 'PATIENT',
  status: 'DRAFT',
  source: 'Policy owner',
  indexingStatus: 'INDEXED',
  indexingError: null,
  indexedAt: '2026-01-02T00:00:00.000Z',
  chunkCount: 3,
  supersededById: null,
  approvedAt: null,
  createdAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  ...over,
});

const detailOf = (d: DocView, versions: DocView[] = [d]): DocDetail => ({ document: d, content: '# Delivery\n\nText.', versions });

describe('Knowledge admin', () => {
  it('asks for confirmation before approving, and calls the API only after confirming', async () => {
    const draft = doc();
    const calls = mockApi({
      'GET /api/v1/auth/me': () => ok(adminSession),
      'GET /api/v1/admin/knowledge/documents': () => ok({ items: [draft] }),
      [`GET /api/v1/admin/knowledge/documents/${draft.id}`]: () => ok(detailOf(draft)),
      [`POST /api/v1/admin/knowledge/documents/${draft.id}/approve`]: () => ok({ ...draft, status: 'APPROVED' }),
    });
    renderAt('/admin/knowledge');
    await userEvent.click(await screen.findByRole('button', { name: /Delivery policy/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Approve this version?')).toBeInTheDocument();
    const approveCalls = () => calls.filter((c: Call) => c.method === 'POST' && c.path.endsWith('/approve'));
    expect(approveCalls()).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(approveCalls()).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Yes, approve' }));
    await waitFor(() => expect(approveCalls()).toHaveLength(1));
  });

  it('shows a failed-indexing badge with the indexing code, and no approve action', async () => {
    const failed = doc({ id: 'doc-failed', slug: 'failing-doc', title: 'Failing document', indexingStatus: 'FAILED', indexingError: 'EMBEDDING_TIMEOUT', chunkCount: 0 });
    mockApi({
      'GET /api/v1/auth/me': () => ok(adminSession),
      'GET /api/v1/admin/knowledge/documents': () => ok({ items: [failed] }),
      [`GET /api/v1/admin/knowledge/documents/${failed.id}`]: () => ok(detailOf(failed)),
    });
    renderAt('/admin/knowledge');
    expect(await screen.findByText('Failed: EMBEDDING_TIMEOUT')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Failing document/ }));
    expect(await screen.findByText('EMBEDDING_TIMEOUT', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });
});
