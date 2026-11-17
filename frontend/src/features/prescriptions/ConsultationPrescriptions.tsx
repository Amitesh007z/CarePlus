import { useNavigate } from 'react-router-dom';
import { FilePlus2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { useToast } from '../../components/ui/Toast';
import { apiRequest } from '../../lib/api';
import { messageOf, useApi } from '../../lib/useApi';
import { RxStatusPill } from './RxStatusPill';
import type { Prescription, RxStatus } from './types';

interface Props {
  consultationId: string;
  finalized: boolean;
}

/** Prescriptions for one consultation. A new draft is always linked to this consultation. */
export function ConsultationPrescriptions({ consultationId, finalized }: Props) {
  const navigate = useNavigate();
  const toast = useToast();
  const list = useApi<{ items: Prescription[] }>(`/api/v1/doctor/consultations/${consultationId}/prescriptions`);

  async function createDraft() {
    try {
      const draft = await apiRequest<Prescription>(`/api/v1/doctor/consultations/${consultationId}/prescriptions`, { method: 'POST' });
      navigate(`/doctor/prescriptions/${draft.id}`);
    } catch (err) {
      toast.notify('error', messageOf(err));
    }
  }

  return (
    <Card
      title="Prescriptions"
      description={finalized ? 'You can issue once the consultation is finalized.' : 'Finalize the consultation before issuing.'}
      actions={<Button variant="secondary" onClick={createDraft}><FilePlus2 className="size-4" aria-hidden="true" /> New</Button>}
    >
      {list.loading && <p role="status" className="text-sm text-slate-500">Loading…</p>}
      {list.error && <p role="alert" className="text-sm text-rose-700">{list.error}</p>}
      {list.data && list.data.items.length === 0 && <p className="text-sm text-slate-500">No prescriptions for this visit.</p>}
      <ul className="space-y-2">
        {list.data?.items.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => navigate(`/doctor/prescriptions/${p.id}`)} className="flex w-full items-center justify-between gap-3 rounded-xl bg-white p-3 text-left text-sm ring-1 ring-slate-200 hover:ring-indigo-300">
              <span className="font-semibold text-ink">{p.rxNumber ?? 'Draft'} · {p.items.length} medicine{p.items.length === 1 ? '' : 's'}</span>
              <RxStatusPill status={p.status as RxStatus} />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
