import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Minus, Plus, ShoppingBag, Trash2 } from 'lucide-react';
import { PageLoader } from '../../components/PageLoader';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { useToast } from '../../components/ui/Toast';
import { apiRequest } from '../../lib/api';
import { messageOf, useApi } from '../../lib/useApi';
import { Hero } from '../dashboards/RoleDashboard';
import { inr, type Cart, type CartLine } from './types';

/** The patient's cart. Every number shown is the server's; quantity changes are sent and the server replies with the new cart. */
export function CartPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const cart = useApi<Cart>('/api/v1/patients/me/cart');
  const [busy, setBusy] = useState(false);

  async function change(path: string, method: 'PATCH' | 'DELETE', body?: object) {
    setBusy(true);
    try {
      await apiRequest<Cart>(path, { method, body });
      cart.reload();
    } catch (err) {
      toast.notify('error', messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  if (cart.loading) return <PageLoader label="Loading your cart" />;
  if (cart.error || !cart.data) {
    return (
      <Card className="mx-auto max-w-lg text-center">
        <p role="alert" className="text-sm font-medium text-ink">{cart.error ?? 'Your cart could not be loaded.'}</p>
        <Button variant="secondary" className="mt-4" onClick={cart.reload}>Try again</Button>
      </Card>
    );
  }
  const data = cart.data;
  const hasLines = data.items.length > 0;
  const blocked = data.blockers.length > 0 || !hasLines;

  return (
    <div className="space-y-8">
      <Hero role="PATIENT" title="Your cart" subtitle="Check quantities and prices before you pay. Prices are calculated by CarePulse." />

      {!hasLines ? (
        <Card className="mx-auto max-w-lg text-center">
          <ShoppingBag className="mx-auto size-10 text-teal-600" aria-hidden="true" />
          <p className="mt-3 font-semibold text-ink">Your cart is empty</p>
          <p className="mt-1 text-sm text-slate-600">Add over-the-counter medicines from the catalogue, or buy a prescription from its page.</p>
          <Link to="/medicines" className="mt-4 inline-block text-sm font-semibold text-teal-700 hover:underline">Browse medicines</Link>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            {groupByPrescription(data.items).map((group) => (
              <section key={group.key} aria-label={group.title} className="space-y-3">
                {group.rxId && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-indigo-50/70 px-4 py-3 ring-1 ring-indigo-100">
                    <p className="text-sm font-semibold text-indigo-900">{group.title}</p>
                    <Button variant="ghost" disabled={busy} onClick={() => change(`/api/v1/patients/me/cart/prescriptions/${group.rxId}`, 'DELETE')}>
                      Remove this prescription
                    </Button>
                  </div>
                )}
                {group.lines.map((line) => (
                  <LineRow key={line.id} line={line} busy={busy} onQuantity={(q) => change(`/api/v1/patients/me/cart/items/${line.id}`, 'PATCH', { quantity: q })} onRemove={() => change(`/api/v1/patients/me/cart/items/${line.id}`, 'DELETE')} />
                ))}
              </section>
            ))}
          </div>

          <aside className="space-y-4">
            <Card title="Order summary">
              <dl className="space-y-2 text-sm">
                <Row label="Subtotal" value={inr(data.summary.subtotalInr)} />
                <Row label="Prescription discount" value={data.summary.discountInr > 0 ? `− ${inr(data.summary.discountInr)}` : inr(0)} />
                <Row label="Delivery" value={data.summary.freeDelivery ? 'Free' : inr(data.summary.deliveryFeeInr)} />
                <div className="flex justify-between border-t border-slate-100 pt-3 text-base font-bold text-ink">
                  <dt>Total</dt>
                  <dd>{inr(data.summary.totalInr)}</dd>
                </div>
              </dl>
              {data.summary.explanation.length > 0 && (
                <ul className="mt-4 space-y-1 text-xs text-slate-500">
                  {data.summary.explanation.map((e) => <li key={e}>{e}</li>)}
                </ul>
              )}
            </Card>

            {data.blockers.length > 0 && (
              <div role="alert" className="flex gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
                <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                <ul className="space-y-1">
                  {data.blockers.map((b) => <li key={b}>{b}</li>)}
                </ul>
              </div>
            )}

            <Button className="w-full" disabled={blocked} onClick={() => navigate('/checkout')}>Checkout</Button>
          </aside>
        </div>
      )}
    </div>
  );
}

function LineRow({ line, busy, onQuantity, onRemove }: { line: CartLine; busy: boolean; onQuantity: (q: number) => void; onRemove: () => void }) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="font-semibold text-ink">{line.medicine.name}</p>
          <p className="text-xs text-slate-500">{[line.medicine.strength, line.medicine.packSize].filter(Boolean).join(' · ')}</p>
          <p className="text-xs text-slate-500">{inr(line.unitPriceInr)} each</p>
          {line.locked && line.prescription && (
            <p className="text-xs font-medium text-indigo-800">From prescription {line.prescription.rxNumber ?? ''}: quantity is fixed</p>
          )}
          {line.problems.map((p) => (
            <p key={p} className="text-xs font-medium text-rose-700">{p}</p>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-xl ring-1 ring-slate-200">
            <button type="button" aria-label={`Decrease quantity of ${line.medicine.name}`} disabled={busy || line.locked || line.quantity <= 1} onClick={() => onQuantity(line.quantity - 1)} className="grid size-10 place-items-center text-slate-600 hover:text-ink disabled:opacity-40">
              <Minus className="size-4" aria-hidden="true" />
            </button>
            <span aria-live="polite" aria-label={`Quantity ${line.quantity}`} className="min-w-10 text-center text-sm font-semibold">{line.quantity}</span>
            <button type="button" aria-label={`Increase quantity of ${line.medicine.name}`} disabled={busy || line.locked || line.quantity >= 100} onClick={() => onQuantity(line.quantity + 1)} className="grid size-10 place-items-center text-slate-600 hover:text-ink disabled:opacity-40">
              <Plus className="size-4" aria-hidden="true" />
            </button>
          </div>
          <p className="w-24 text-right font-semibold text-ink">{inr(line.lineTotalInr)}</p>
          {!line.locked && (
            <button type="button" aria-label={`Remove ${line.medicine.name}`} disabled={busy} onClick={onRemove} className="rounded-lg p-2 text-slate-500 hover:bg-rose-50 hover:text-rose-700">
              <Trash2 className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-600">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}

/** Keeps each prescription's lines together, with the catalogue lines after. */
function groupByPrescription(items: CartLine[]) {
  const groups = new Map<string, { key: string; title: string; rxId: string | null; lines: CartLine[] }>();
  for (const line of items) {
    const key = line.prescription ? line.prescription.id : 'catalogue';
    const group = groups.get(key) ?? {
      key,
      title: line.prescription ? `From prescription ${line.prescription.rxNumber ?? ''}` : 'Over the counter',
      rxId: line.prescription?.id ?? null,
      lines: [],
    };
    group.lines.push(line);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => Number(a.rxId === null) - Number(b.rxId === null));
}
