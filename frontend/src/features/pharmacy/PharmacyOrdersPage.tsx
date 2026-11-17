import { useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Ban, CheckCircle2, PackageCheck, Truck } from 'lucide-react';
import { PageLoader } from '../../components/PageLoader';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { apiRequest } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { messageOf, useApi } from '../../lib/useApi';
import type { PageMeta } from '../../types/clinical';
import { Hero } from '../dashboards/RoleDashboard';
import { inr, ORDER_STATUS_LABEL, ORDER_STATUS_TONE, type PharmacyOrder, type PharmacyOrderAction, type PharmacyOrderSummary, type OrderStatus } from '../commerce/types';

const VIEWS = [
  { key: 'queue', label: 'Waiting' },
  { key: 'active', label: 'In progress' },
  { key: 'done', label: 'Completed' },
] as const;

/** The next step the pharmacist can take for each status. The server enforces the same rules. */
const NEXT: Partial<Record<OrderStatus, { action: PharmacyOrderAction; label: string; icon: typeof CheckCircle2 }>> = {
  PLACED: { action: 'verify', label: 'Verify order', icon: CheckCircle2 },
  VERIFIED: { action: 'pack', label: 'Pack order', icon: PackageCheck },
  PACKED: { action: 'dispatch', label: 'Mark out for delivery', icon: Truck },
  OUT_FOR_DELIVERY: { action: 'deliver', label: 'Mark delivered', icon: CheckCircle2 },
};
const CAN_REJECT: OrderStatus[] = ['PLACED', 'VERIFIED'];

/** Pharmacist order queue, split like the prescription queue. The view is kept in the URL. */
export function PharmacyOrdersPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('view') ?? 'queue';
  const view = VIEWS.some((v) => v.key === requested) ? requested : 'queue';
  const list = useApi<{ items: PharmacyOrderSummary[]; meta: PageMeta }>(`/api/v1/pharmacy/orders?view=${view}&page=1`);

  return (
    <div className="space-y-8">
      <Hero role="PHARMACIST" title="Order queue" subtitle="Verify each order, pack it, and track delivery through to the patient." />
      <div role="tablist" aria-label="Order views" className="inline-flex gap-1 rounded-2xl bg-white/80 p-1 ring-1 ring-slate-900/5">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            role="tab"
            aria-selected={view === v.key}
            onClick={() => setParams({ view: v.key }, { replace: true })}
            className={`min-h-10 rounded-xl px-4 text-sm font-semibold transition ${view === v.key ? 'bg-teal-600 text-white shadow-md shadow-teal-600/20' : 'text-slate-600 hover:text-ink'}`}
          >
            {v.label}
          </button>
        ))}
      </div>
      {list.loading && <PageLoader label="Loading orders" />}
      {list.error && <p role="alert" className="text-sm text-rose-700">{list.error}</p>}
      {list.data && list.data.items.length === 0 && <p className="text-sm text-slate-600">Nothing here right now.</p>}
      {list.data && list.data.items.length > 0 && (
        <ul className="space-y-3">
          {list.data.items.map((o) => (
            <li key={o.id}>
              <Link to={`/pharmacy/orders/${o.id}`} className="flex items-center justify-between gap-4 rounded-2xl bg-white/90 p-5 shadow-sm ring-1 ring-slate-900/5 transition hover:ring-teal-300">
                <div className="min-w-0">
                  <p className="font-semibold text-ink">{o.patientName} <span className="font-normal text-slate-500">· {o.orderNumber}</span></p>
                  <p className="text-xs text-slate-500">{formatDateTime(o.placedAt)} · {o.itemCount} item{o.itemCount === 1 ? '' : 's'}{o.isPrescriptionOrder ? ' · prescription' : ''}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${ORDER_STATUS_TONE[o.status]}`}>{ORDER_STATUS_LABEL[o.status]}</span>
                  <span className="font-semibold text-ink">{inr(o.totalInr)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One order for the pharmacist. Buttons appear only for steps the current status allows. */
export function PharmacyOrderPage() {
  const { orderId = '' } = useParams();
  const toast = useToast();
  const order = useApi<PharmacyOrder>(`/api/v1/pharmacy/orders/${orderId}`);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);

  if (order.loading) return <PageLoader label="Opening order" />;
  if (order.error || !order.data) {
    return (
      <Card className="mx-auto max-w-lg text-center">
        <p role="alert" className="text-sm font-medium text-ink">{order.error ?? 'Order not found.'}</p>
        <Link to="/pharmacy/orders" className="mt-4 inline-block text-sm font-semibold text-teal-700 hover:underline">Back to the queue</Link>
      </Card>
    );
  }
  const o = order.data;
  const next = NEXT[o.status];

  async function act(action: PharmacyOrderAction, why?: string) {
    setBusy(true);
    try {
      await apiRequest<PharmacyOrder>(`/api/v1/pharmacy/orders/${o.id}/actions`, { method: 'POST', body: why ? { action, reason: why } : { action } });
      toast.notify('success', action === 'reject' ? 'Order rejected. Stock has been returned.' : 'Order updated');
      order.reload();
    } catch (err) {
      toast.notify('error', messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  function submitReject(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 3) return setReasonError('Give a reason of at least 3 characters');
    setRejecting(false);
    void act('reject', reason.trim());
  }

  return (
    <div className="space-y-8">
      <Link to="/pharmacy/orders" className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-800 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Back to the queue
      </Link>
      <Hero role="PHARMACIST" title={`${o.orderNumber} for ${o.patient.name}`} subtitle={`Placed ${formatDateTime(o.placedAt)}`} chips={[ORDER_STATUS_LABEL[o.status]]} />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Items">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr><th scope="col" className="py-2">Medicine</th><th scope="col" className="py-2 text-right">Qty</th><th scope="col" className="py-2 text-right">Total</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {o.items.map((it) => (
                  <tr key={it.lineNo}>
                    <td className="py-3">
                      <p className="font-semibold text-ink">{it.name}</p>
                      <p className="text-xs text-slate-500">{[it.sku, it.strength, it.packSize].filter(Boolean).join(' · ')}</p>
                      {it.prescriptionRxNumber && <p className="text-xs text-indigo-800">Prescription {it.prescriptionRxNumber}</p>}
                    </td>
                    <td className="py-3 text-right">{it.quantity}</td>
                    <td className="py-3 text-right font-medium">{inr(it.lineTotalInr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          {o.prescriptions.length > 0 && (
            <Card title="Prescriptions">
              <ul className="space-y-1 text-sm text-slate-700">
                {o.prescriptions.map((p) => (
                  <li key={p.rxNumber ?? 'rx'}>
                    {p.id ? <Link to={`/pharmacy/prescriptions/${p.id}`} className="font-semibold text-teal-700 hover:underline">{p.rxNumber}</Link> : <span className="font-semibold">{p.rxNumber}</span>}
                    {p.validTill ? ` · valid till ${p.validTill}` : ''}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {o.statusReason && <p className="rounded-2xl bg-rose-50 p-4 text-sm text-rose-800">{o.statusReason}</p>}
          {o.events && o.events.length > 0 && (
            <Card title="History" description="Every step, who took it, and when.">
              <ol className="space-y-3 text-sm">
                {o.events.map((e, i) => (
                  <li key={`${e.at}-${i}`} className="flex gap-3">
                    <span className="mt-1.5 size-2 shrink-0 rounded-full bg-teal-500" aria-hidden="true" />
                    <div>
                      <p className="font-medium text-ink">{ORDER_STATUS_LABEL[e.toStatus as OrderStatus] ?? e.toStatus}</p>
                      <p className="text-xs text-slate-500">{e.actorRole === 'PHARMACIST' ? 'Pharmacist' : e.actorRole === 'PATIENT' ? 'Patient' : 'System'} · {formatDateTime(e.at)}</p>
                      {e.reason && <p className="mt-1 text-xs text-slate-600">Reason: {e.reason}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </div>

        <aside className="space-y-4">
          <Card title="Total">
            <p className="text-2xl font-bold text-ink">{inr(o.totalInr)}</p>
            <p className="mt-1 text-xs text-slate-500">{o.paymentMethod === 'COD' ? 'Cash on delivery' : 'Simulated card'} · {o.isPrescriptionOrder ? 'Prescription order' : 'Over the counter'}</p>
          </Card>
          {next && (
            <Button className="w-full" loading={busy} onClick={() => act(next.action)}>
              <next.icon className="size-4" aria-hidden="true" /> {next.label}
            </Button>
          )}
          {CAN_REJECT.includes(o.status) && (
            <Button variant="danger" className="w-full" disabled={busy} onClick={() => setRejecting(true)}>
              <Ban className="size-4" aria-hidden="true" /> Reject order
            </Button>
          )}
          {!next && !CAN_REJECT.includes(o.status) && <p className="text-sm text-slate-600">No further steps for this order.</p>}
        </aside>
      </div>

      <Modal open={rejecting} title="Reject this order?" onClose={() => setRejecting(false)}>
        <form onSubmit={submitReject} noValidate className="space-y-4">
          <p className="text-sm text-slate-600">The reserved stock is returned. The patient sees this reason.</p>
          <div className="space-y-1.5">
            <label htmlFor="reject-reason" className="text-sm font-medium text-ink">Reason</label>
            <textarea id="reject-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className="block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
            {reasonError && <p role="alert" className="text-sm text-rose-700">{reasonError}</p>}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRejecting(false)}>Keep order</Button>
            <Button type="submit" variant="danger">Reject order</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
