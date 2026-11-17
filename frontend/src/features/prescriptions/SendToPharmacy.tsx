import { useState } from 'react';
import { Send, Store } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ApiError, apiRequest } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { messageOf } from '../../lib/useApi';
import { FULFILMENT_LABEL, FULFILMENT_TONE, type FulfilmentStatus } from '../pharmacy/types';
import type { RxStatus } from './types';

export interface PatientFulfilment {
  status: FulfilmentStatus;
  requestedAt: string;
  verifiedAt: string | null;
  packedAt: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
}

/** Patient: sends an issued prescription to a pharmacy and shows where it is. Re-sending is allowed after a rejection. */
export function SendToPharmacy({ rxId, status, fulfilment, onChanged }: { rxId: string; status: RxStatus; fulfilment: PatientFulfilment | null; onChanged: () => void }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSend = status === 'ISSUED' && (fulfilment === null || fulfilment.status === 'REJECTED');
  if (status === 'DRAFT' || (fulfilment === null && !canSend)) return null;

  async function send() {
    setSending(true);
    setError(null);
    try {
      await apiRequest(`/api/v1/patients/me/prescriptions/${rxId}/fulfilment`, { method: 'POST' });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : messageOf(err));
    } finally {
      setSending(false);
    }
  }

  const steps: [string, string | null][] = fulfilment
    ? [
        ['Sent to pharmacy', fulfilment.requestedAt],
        ['Checked', fulfilment.verifiedAt],
        ['Packed', fulfilment.packedAt],
        ['Out for delivery', fulfilment.dispatchedAt],
        ['Delivered', fulfilment.deliveredAt],
        ['Not dispensed', fulfilment.rejectedAt],
      ]
    : [];

  return (
    <Card title="Pharmacy" description="Send this prescription to a pharmacy to have it dispensed. It can be sent once at a time.">
      <div className="space-y-4">
        {fulfilment && (
          <>
            <p className="flex items-center gap-2 text-sm">
              <Store className="size-4 text-teal-700" aria-hidden="true" />
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${FULFILMENT_TONE[fulfilment.status]}`}>{FULFILMENT_LABEL[fulfilment.status]}</span>
            </p>
            {fulfilment.status === 'REJECTED' && (
              <p role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-900">
                The pharmacy could not dispense this prescription{fulfilment.rejectionReason ? `: ${fulfilment.rejectionReason}` : '.'} You can send it again or try another pharmacy.
              </p>
            )}
            <ol className="space-y-1.5 text-sm">
              {steps.filter(([, at]) => at !== null).map(([label, at]) => (
                <li key={label} className="flex justify-between gap-3">
                  <span className="text-slate-600">{label}</span>
                  <span className="font-medium text-ink">{formatDateTime(at!)}</span>
                </li>
              ))}
            </ol>
          </>
        )}
        {error && <p role="alert" className="text-sm font-medium text-rose-600">{error}</p>}
        {canSend && (
          <Button onClick={send} loading={sending}>
            <Send className="size-4" aria-hidden="true" /> Send to pharmacy
          </Button>
        )}
      </div>
    </Card>
  );
}
