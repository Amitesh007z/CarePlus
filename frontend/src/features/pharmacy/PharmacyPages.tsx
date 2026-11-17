import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Ban, CheckCircle2, History, PackageCheck, Truck } from 'lucide-react';
import { PageLoader } from '../../components/PageLoader';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { ApiError, apiRequest } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { messageOf, useApi } from '../../lib/useApi';
import type { PageMeta } from '../../types/clinical';
import { Hero } from '../dashboards/RoleDashboard';
import { AVAILABILITY_LABEL, AVAILABILITY_TONE } from '../catalogue/types';
import { FULFILMENT_LABEL, FULFILMENT_TONE, type FulfilmentAction, type FulfilmentDetail, type Movement, type QueueItem, type StockRow } from './types';

const VIEWS = [
  { key: 'queue', label: 'Waiting' },
  { key: 'active', label: 'In progress' },
  { key: 'done', label: 'Completed' },
] as const;

const NEXT: Record<string, { action: FulfilmentAction; label: string; done: string }[]> = {
  QUEUED: [{ action: 'verify', label: 'Verify prescription', done: 'Prescription verified' }],
  VERIFIED: [{ action: 'pack', label: 'Pack and dispense', done: 'Packed and dispensed; stock updated' }],
  PACKED: [{ action: 'dispatch', label: 'Mark out for delivery', done: 'Marked out for delivery' }],
  OUT_FOR_DELIVERY: [{ action: 'deliver', label: 'Mark delivered', done: 'Marked delivered' }],
};
const ICON: Record<FulfilmentAction, typeof CheckCircle2> = {
  verify: CheckCircle2,
  pack: PackageCheck,
  dispatch: Truck,
  deliver: CheckCircle2,
  reject: Ban,
};

/** Pharmacist queue: waiting, in-progress and completed requests. The view is kept in the URL. */
export function PharmacyQueuePage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('view') ?? 'queue';
  const view = VIEWS.some((v) => v.key === requested) ? requested : 'queue';
  const list = useApi<{ items: QueueItem[]; meta: PageMeta }>(`/api/v1/pharmacy/fulfilments?view=${view}&pageSize=50`);

  return (
    <div className="space-y-8">
      <Hero role="PHARMACIST" title="Prescription queue" subtitle="Verify each prescription, pack and dispense it, then track delivery." />
      <div role="tablist" aria-label="Queue views" className="inline-flex gap-1 rounded-2xl bg-white/80 p-1 ring-1 ring-slate-900/5">
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

      {list.loading && <PageLoader label="Loading queue" />}
      {list.error && <p role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-800">{list.error}</p>}
      {list.data && list.data.items.length === 0 && <p className="text-sm text-slate-500">Nothing here right now.</p>}
      {list.data && list.data.items.length > 0 && (
        <ul className="grid gap-3">
          {list.data.items.map((r) => (
            <li key={r.id}>
              <Link to={`/pharmacy/fulfilments/${r.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white/90 p-5 shadow-sm ring-1 ring-slate-900/5 transition hover:ring-teal-300">
                <div>
                  <p className="font-semibold text-ink">{r.patientName} <span className="font-normal text-slate-500">· {r.rxNumber ?? 'Not numbered'}</span></p>
                  <p className="text-sm text-slate-500">{r.doctorName} · {r.itemCount} medicine{r.itemCount === 1 ? '' : 's'} · requested {formatDateTime(r.requestedAt)}</p>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${FULFILMENT_TONE[r.status]}`}>{FULFILMENT_LABEL[r.status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One request: verify, pack (dispenses and deducts stock), dispatch, deliver, or reject with a reason. */
export function PharmacyFulfilmentPage() {
  const { fulfilmentId = '' } = useParams();
  const toast = useToast();
  const loaded = useApi<FulfilmentDetail>(`/api/v1/pharmacy/fulfilments/${fulfilmentId}`);
  const [current, setCurrent] = useState<FulfilmentDetail | null>(null);
  const [busy, setBusy] = useState<FulfilmentAction | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);

  if (loaded.loading) return <PageLoader label="Opening request" />;
  if (loaded.error || !loaded.data) {
    return (
      <Card className="mx-auto max-w-lg text-center">
        <p role="alert" className="text-sm font-medium text-ink">{loaded.error ?? 'Request not found.'}</p>
        <Link to="/pharmacy/queue" className="mt-4 inline-block text-sm font-semibold text-teal-700 hover:underline">Back to the queue</Link>
      </Card>
    );
  }
  const detail = current && current.id === loaded.data.id ? current : loaded.data;
  const steps = NEXT[detail.status] ?? [];
  const canReject = detail.status === 'QUEUED' || detail.status === 'VERIFIED';

  async function run(action: FulfilmentAction, why?: string) {
    setBusy(action);
    setActionError(null);
    try {
      const next = await apiRequest<FulfilmentDetail>(`/api/v1/pharmacy/fulfilments/${detail.id}/actions`, {
        method: 'POST',
        body: why === undefined ? { action } : { action, reason: why },
      });
      setCurrent(next);
      setRejecting(false);
      setReason('');
      const done = [...steps, { action: 'reject' as const, done: 'Request rejected' }].find((s) => s.action === action)?.done ?? 'Updated';
      toast.notify('success', done);
    } catch (err) {
      setActionError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', messageOf(err)));
    } finally {
      setBusy(null);
    }
  }

  function submitReject(e: FormEvent) {
    e.preventDefault();
    const why = reason.trim();
    if (why.length < 3) {
      setReasonError('Give a reason of at least 3 characters');
      return;
    }
    setReasonError(null);
    void run('reject', why);
  }

  const timeline: [string, string | null][] = [
    ['Requested', detail.timeline.requestedAt],
    ['Checked', detail.timeline.verifiedAt],
    ['Packed and dispensed', detail.timeline.packedAt],
    ['Out for delivery', detail.timeline.dispatchedAt],
    ['Delivered', detail.timeline.deliveredAt],
    ['Rejected', detail.timeline.rejectedAt],
  ];

  return (
    <div className="space-y-8">
      <Link to="/pharmacy/queue" className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-800 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Queue
      </Link>
      <Hero role="PHARMACIST" title={`${detail.prescription.rxNumber ?? 'Prescription'} for ${detail.prescription.patient.name}`} subtitle={`Prescribed by ${detail.prescription.doctor.name}`} chips={[FULFILMENT_LABEL[detail.status]]} />

      {actionError && (
        <div role="alert" className="rounded-2xl border border-rose-300 bg-rose-50 p-5 text-sm text-rose-900">
          <p className="font-semibold">{actionError.message}</p>
          {actionError.details.map((d) => <p key={`${d.path ?? ''}${d.message}`}>{d.message}</p>)}
        </div>
      )}

      {steps.length > 0 || canReject ? (
        <Card title="Next step">
          {detail.status === 'VERIFIED' && !detail.canPack && (
            <p className="mb-4 text-sm text-amber-900">Packing is blocked until stock covers every line.</p>
          )}
          <div className="flex flex-wrap gap-3">
            {steps.map((s) => {
              const Icon = ICON[s.action];
              return (
                <Button
                  key={s.action}
                  loading={busy === s.action}
                  disabled={s.action === 'pack' && !detail.canPack}
                  onClick={() => run(s.action)}
                >
                  <Icon className="size-4" aria-hidden="true" /> {s.label}
                </Button>
              );
            })}
            {canReject && (
              <Button variant="danger" onClick={() => setRejecting(true)} disabled={busy !== null}>
                <Ban className="size-4" aria-hidden="true" /> Reject request
              </Button>
            )}
          </div>
        </Card>
      ) : (
        <p className="text-sm text-slate-500">This request is closed. {detail.status === 'REJECTED' && detail.rejectionReason ? `Reason: ${detail.rejectionReason}` : ''}</p>
      )}

      {detail.shortfalls.length > 0 && (
        <div role="alert" className="flex gap-4 rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold">Not enough stock to pack</p>
            <ul className="mt-1 list-disc pl-5">
              {detail.shortfalls.map((s) => <li key={s.medicineId}>{s.name}: {s.available} on hand, {s.needed} needed</li>)}
            </ul>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Medicines" className="lg:col-span-2">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="py-2 pr-3">Medicine</th>
                  <th scope="col" className="py-2 pr-3">Directions</th>
                  <th scope="col" className="py-2 pr-3">Qty</th>
                  <th scope="col" className="py-2">Stock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {detail.items.map((i) => (
                  <tr key={i.lineNo}>
                    <td className="py-3 pr-3 font-medium text-ink">{i.name}{i.strength ? ` · ${i.strength}` : ''}</td>
                    <td className="py-3 pr-3 text-slate-600">{i.dose}, {i.frequency}, {i.durationDays} day{i.durationDays === 1 ? '' : 's'}{i.instructions ? ` (${i.instructions})` : ''}</td>
                    <td className="py-3 pr-3">{i.quantity}</td>
                    <td className="py-3">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${AVAILABILITY_TONE[i.availability]}`}>{i.stockOnHand} · {AVAILABILITY_LABEL[i.availability]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="space-y-6">
          <Card title="Patient and prescriber">
            <dl className="space-y-2 text-sm">
              <div><dt className="text-slate-500">Patient</dt><dd className="font-medium text-ink">{detail.prescription.patient.name}, born {detail.prescription.patient.dob}</dd></div>
              <div><dt className="text-slate-500">Prescriber</dt><dd className="font-medium text-ink">{detail.prescription.doctor.name} · {detail.prescription.doctor.registrationNo}</dd></div>
              <div><dt className="text-slate-500">Valid till</dt><dd className="font-medium text-ink">{detail.prescription.validTill ?? 'Not issued'}</dd></div>
            </dl>
          </Card>
          <Card title="Timeline">
            <ol className="space-y-2 text-sm">
              {timeline.filter(([, at]) => at !== null).map(([label, at]) => (
                <li key={label} className="flex justify-between gap-3"><span className="text-slate-600">{label}</span><span className="font-medium text-ink">{formatDateTime(at!)}</span></li>
              ))}
            </ol>
          </Card>
        </div>
      </div>

      <Modal open={rejecting} title="Reject this request?" onClose={() => setRejecting(false)}>
        <form onSubmit={submitReject} noValidate className="space-y-4">
          <p className="text-sm text-slate-600">The prescription stays issued. Say why it cannot be dispensed here. The reason is shown to the patient.</p>
          <div className="space-y-1.5">
            <label htmlFor="reject-reason" className="block text-sm font-medium text-ink">Reason for rejecting</label>
            <textarea
              id="reject-reason"
              rows={3}
              maxLength={300}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={reasonError ? true : undefined}
              aria-describedby={reasonError ? 'reject-reason-error' : undefined}
              className="block w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm shadow-sm focus:border-rose-500 focus:outline-none focus:ring-4 focus:ring-rose-500/15"
            />
            {reasonError && <p id="reject-reason-error" role="alert" className="text-sm font-medium text-rose-600">{reasonError}</p>}
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setRejecting(false)}>Keep request</Button>
            <Button variant="danger" type="submit" loading={busy === 'reject'}>Reject request</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/** Stock list with low-stock filter, adjustments (recorded as ledger rows) and movement history. */
export function PharmacyStockPage() {
  const toast = useToast();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [selected, setSelected] = useState<StockRow | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const qs = new URLSearchParams({ pageSize: '50', lowOnly: String(lowOnly) });
  if (q) qs.set('q', q);
  const stock = useApi<{ items: StockRow[]; meta: PageMeta; lowStockThreshold: number }>(`/api/v1/pharmacy/stock?${qs}`);
  const movements = useApi<{ items: Movement[] }>(selected ? `/api/v1/pharmacy/medicines/${selected.id}/movements` : null);

  function openAdjust(row: StockRow) {
    setSelected(row);
    setDelta('');
    setNote('');
    setFormError(null);
    setAdjusting(true);
  }

  async function submitAdjust(e: FormEvent) {
    e.preventDefault();
    const change = Number(delta);
    if (!Number.isInteger(change) || change === 0) return setFormError('Enter a whole number of units, for example 20 or -5');
    if (note.trim().length < 3) return setFormError('Say why the stock changed (at least 3 characters)');
    if (!selected) return;
    setSaving(true);
    setFormError(null);
    try {
      const r = await apiRequest<{ stockOnHand: number }>(`/api/v1/pharmacy/medicines/${selected.id}/stock`, {
        method: 'POST',
        body: { delta: change, note: note.trim() },
      });
      toast.notify('success', `${selected.name}: stock is now ${r.stockOnHand}`);
      setAdjusting(false);
      stock.reload();
      movements.reload();
    } catch (err) {
      setFormError(messageOf(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <Hero role="PHARMACIST" title="Stock" subtitle="Current stock and every change. Stock cannot go below zero." />
      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-60 flex-1">
            <Input label="Search stock" type="search" placeholder="Name or SKU" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <Button variant={lowOnly ? 'primary' : 'secondary'} aria-pressed={lowOnly} onClick={() => setLowOnly((v) => !v)}>
            <AlertTriangle className="size-4" aria-hidden="true" /> Low stock only
          </Button>
        </div>
      </Card>

      {stock.loading && <PageLoader label="Loading stock" />}
      {stock.error && <p role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-800">{stock.error}</p>}
      {stock.data && stock.data.items.length === 0 && <p className="text-sm text-slate-500">No medicines match.</p>}
      {stock.data && stock.data.items.length > 0 && (
        <div className="overflow-x-auto rounded-2xl bg-white/90 shadow-sm ring-1 ring-slate-900/5">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-3">Medicine</th>
                <th scope="col" className="px-4 py-3">SKU</th>
                <th scope="col" className="px-4 py-3">On hand</th>
                <th scope="col" className="px-4 py-3">Status</th>
                <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {stock.data.items.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-3 font-medium text-ink">{r.name}{!r.active && <span className="ml-2 text-xs text-slate-500">(inactive)</span>}</td>
                  <td className="px-4 py-3 text-slate-600">{r.sku}</td>
                  <td className="px-4 py-3 tabular-nums">{r.stockOnHand}</td>
                  <td className="px-4 py-3"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${AVAILABILITY_TONE[r.availability]}`}>{AVAILABILITY_LABEL[r.availability]}</span></td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" className="min-h-9 px-3" aria-pressed={selected?.id === r.id} onClick={() => setSelected(r)}>
                        <History className="size-4" aria-hidden="true" /> History
                      </Button>
                      <Button variant="secondary" className="min-h-9 px-3" onClick={() => openAdjust(r)}>Adjust</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <Card title={`History: ${selected.name}`} description="Newest first. Every change is a ledger row and cannot be edited.">
          {movements.loading && <p role="status" className="text-sm text-slate-500">Loading history…</p>}
          {movements.data && movements.data.items.length === 0 && <p className="text-sm text-slate-500">No changes recorded yet.</p>}
          {movements.data && movements.data.items.length > 0 && (
            <ul className="divide-y divide-slate-100 text-sm">
              {movements.data.items.map((m, i) => (
                <li key={`${m.createdAt}-${i}`} className="flex flex-wrap justify-between gap-2 py-2.5">
                  <span className="text-slate-700">{m.reason === 'DISPENSE' ? 'Dispensed' : 'Adjusted'}{m.note ? ` · ${m.note}` : ''}</span>
                  <span className="tabular-nums">{m.delta > 0 ? `+${m.delta}` : m.delta} → {m.balanceAfter} on hand · {formatDateTime(m.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Modal open={adjusting} title={`Adjust stock: ${selected?.name ?? ''}`} onClose={() => setAdjusting(false)}>
        <form onSubmit={submitAdjust} noValidate className="space-y-4">
          <Input label="Change in units" hint="Use a minus sign to remove stock, for example -5" type="number" inputMode="numeric" value={delta} onChange={(e) => setDelta(e.target.value)} />
          <Input label="Reason" hint="For example: delivery received, damaged, count correction" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
          {formError && <p role="alert" className="text-sm font-medium text-rose-600">{formError}</p>}
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setAdjusting(false)}>Cancel</Button>
            <Button type="submit" loading={saving}>Save adjustment</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
