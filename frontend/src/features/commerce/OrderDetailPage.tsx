import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Circle, XCircle } from 'lucide-react';
import { PageLoader } from '../../components/PageLoader';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { apiRequest } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { messageOf, useApi } from '../../lib/useApi';
import { Hero } from '../dashboards/RoleDashboard';
import { inr, ORDER_STATUS_LABEL, ORDER_STATUS_TONE, PAYMENT_LABEL, type Order } from './types';

const STEPS = [
  { key: 'placedAt', label: 'Placed' },
  { key: 'verifiedAt', label: 'Checked by pharmacist' },
  { key: 'packedAt', label: 'Packed' },
  { key: 'dispatchedAt', label: 'Out for delivery' },
  { key: 'deliveredAt', label: 'Delivered' },
] as const;

interface PlacementState {
  justPlaced?: boolean;
  replayed?: boolean;
}

/** One order, with tracking. The server decides what is allowed; the page only offers cancel while the order is PLACED. */
export function OrderDetailPage() {
  const { orderId = '' } = useParams();
  const location = useLocation();
  const placement = (location.state ?? {}) as PlacementState;
  const toast = useToast();
  const order = useApi<Order>(`/api/v1/patients/me/orders/${orderId}`);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);

  if (order.loading) return <PageLoader label="Loading order" />;
  if (order.error || !order.data) {
    return (
      <Card className="mx-auto max-w-lg text-center">
        <p role="alert" className="text-sm font-medium text-ink">{order.error ?? 'Order not found.'}</p>
        <Link to="/orders" className="mt-4 inline-block text-sm font-semibold text-indigo-700 hover:underline">Back to orders</Link>
      </Card>
    );
  }
  const o = order.data;

  async function cancel() {
    setBusy(true);
    try {
      await apiRequest<Order>(`/api/v1/patients/me/orders/${o.id}/cancel`, { method: 'POST', body: {} });
      setCancelling(false);
      toast.notify('success', 'Order cancelled. Stock has been released.');
      order.reload();
    } catch (err) {
      toast.notify('error', messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <Link to="/orders" className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-800 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> All orders
      </Link>
      <Hero role="PATIENT" title={`Order ${o.orderNumber}`} subtitle={`Placed ${formatDateTime(o.placedAt)}`} chips={[ORDER_STATUS_LABEL[o.status]]} />

      {placement.justPlaced && !placement.replayed && (
        <div role="status" className="flex gap-3 rounded-2xl border border-emerald-300 bg-emerald-50 p-5 text-emerald-900">
          <CheckCircle2 className="mt-0.5 size-6 shrink-0 text-emerald-600" aria-hidden="true" />
          <div>
            <p className="font-semibold">Order placed</p>
            <p className="text-sm">A pharmacist will check it before dispatch. You can follow progress on this page.</p>
          </div>
        </div>
      )}
      {(placement.replayed || o.replayed) && (
        <p role="status" className="rounded-2xl bg-sky-50 p-4 text-sm text-sky-900">This order was already placed. Your retry did not create a second order.</p>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Tracking">
            {o.status === 'REJECTED' || o.status === 'CANCELLED' ? (
              <div className={`flex gap-3 rounded-2xl p-4 ring-1 ${ORDER_STATUS_TONE[o.status]}`}>
                <XCircle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                <div className="text-sm">
                  <p className="font-semibold">{ORDER_STATUS_LABEL[o.status]}</p>
                  {o.statusReason && <p className="mt-1">{o.statusReason}</p>}
                  <p className="mt-1 text-xs opacity-80">{formatDateTime((o.status === 'REJECTED' ? o.timeline.rejectedAt : o.timeline.cancelledAt) ?? o.placedAt)}</p>
                </div>
              </div>
            ) : (
              <ol className="space-y-4">
                {STEPS.map((step) => {
                  const at = o.timeline[step.key];
                  const done = at !== null;
                  return (
                    <li key={step.key} className="flex items-start gap-3">
                      {done ? <CheckCircle2 className="mt-0.5 size-5 text-emerald-600" aria-hidden="true" /> : <Circle className="mt-0.5 size-5 text-slate-300" aria-hidden="true" />}
                      <div>
                        <p className={`text-sm font-semibold ${done ? 'text-ink' : 'text-slate-400'}`}>{step.label}</p>
                        {at && <p className="text-xs text-slate-500">{formatDateTime(at)}</p>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            <p className="mt-4 text-sm">
              Status: <span className={`ml-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${ORDER_STATUS_TONE[o.status]}`}>{ORDER_STATUS_LABEL[o.status]}</span>
            </p>
          </Card>

          <Card title="Items" description="Prices are the prices at the time you ordered. Later catalogue changes do not affect this order.">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="py-2">Medicine</th>
                  <th scope="col" className="py-2 text-right">Qty</th>
                  <th scope="col" className="py-2 text-right">Price</th>
                  <th scope="col" className="py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {o.items.map((it) => (
                  <tr key={it.lineNo}>
                    <td className="py-3">
                      <p className="font-semibold text-ink">{it.name}</p>
                      <p className="text-xs text-slate-500">{[it.sku, it.strength, it.packSize].filter(Boolean).join(' · ')}</p>
                      {it.prescriptionRxNumber && <p className="text-xs text-indigo-800">From prescription {it.prescriptionRxNumber}</p>}
                    </td>
                    <td className="py-3 text-right">{it.quantity}</td>
                    <td className="py-3 text-right">{inr(it.unitPriceInr)}</td>
                    <td className="py-3 text-right font-medium">{inr(it.lineTotalInr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>

        <aside className="space-y-4">
          <Card title="Total">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-slate-600">Subtotal</dt><dd>{inr(o.subtotalInr)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-600">Prescription discount</dt><dd>{o.discountInr > 0 ? `− ${inr(o.discountInr)}` : inr(0)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-600">Delivery</dt><dd>{o.deliveryFeeInr === 0 ? 'Free' : inr(o.deliveryFeeInr)}</dd></div>
              <div className="flex justify-between border-t border-slate-100 pt-3 text-base font-bold text-ink"><dt>Paid or payable</dt><dd>{inr(o.totalInr)}</dd></div>
            </dl>
            <ul className="mt-4 space-y-1 text-xs text-slate-500">
              {o.explanation.map((e) => <li key={e}>{e}</li>)}
            </ul>
          </Card>
          <Card title="Delivery to">
            <p className="text-sm text-slate-700">{o.address.label}: {o.address.line}, {o.address.city}, {o.address.state} {o.address.pincode}</p>
          </Card>
          <Card title="Payment">
            <p className="text-sm text-slate-700">{PAYMENT_LABEL[o.paymentStatus]}</p>
            <p className="text-xs text-slate-500">{o.paymentMethod === 'COD' ? 'Cash on delivery' : 'Simulated card'}</p>
          </Card>
          {o.status === 'PLACED' && (
            <Button variant="danger" className="w-full" onClick={() => setCancelling(true)}>Cancel order</Button>
          )}
        </aside>
      </div>

      <Modal open={cancelling} title="Cancel this order?" onClose={() => setCancelling(false)}>
        <div className="space-y-4">
          <p className="text-sm text-slate-600">Cancelling releases the reserved stock. You can order again any time. This cannot be undone.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCancelling(false)}>Keep order</Button>
            <Button variant="danger" loading={busy} onClick={cancel}>Yes, cancel</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
