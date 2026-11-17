import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CreditCard, MapPin, Plus, Wallet } from 'lucide-react';
import { PageLoader } from '../../components/PageLoader';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Input';
import { ApiError, apiRequest } from '../../lib/api';
import { messageOf, useApi } from '../../lib/useApi';
import { Hero } from '../dashboards/RoleDashboard';
import { inr, type Address, type Cart, type Order, type PaymentMethod } from './types';

const PINCODE = /^[1-9][0-9]{5}$/;

/** One key per checkout attempt. A retry sends the same key, so the server returns the original order instead of a second one. */
function newIdempotencyKey(): string {
  const id = globalThis.crypto?.randomUUID?.();
  return id ?? `checkout-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

interface AddressForm {
  label: string;
  line: string;
  city: string;
  state: string;
  pincode: string;
}
const EMPTY_ADDRESS: AddressForm = { label: 'Home', line: '', city: '', state: '', pincode: '' };

export function CheckoutPage() {
  const navigate = useNavigate();
  const cart = useApi<Cart>('/api/v1/patients/me/cart');
  const addresses = useApi<{ items: Address[] }>('/api/v1/patients/me/addresses');
  const [addressId, setAddressId] = useState<string | null>(null);
  const [payment, setPayment] = useState<PaymentMethod>('MOCK_CARD');
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (cart.loading || addresses.loading) return <PageLoader label="Preparing checkout" />;
  if (cart.error || addresses.error || !cart.data || !addresses.data) {
    return <p role="alert" className="text-sm text-rose-700">{cart.error ?? addresses.error ?? 'Checkout could not be loaded.'}</p>;
  }
  const data = cart.data;
  const list = addresses.data.items;
  const selected = addressId ?? list.find((a) => a.isDefault)?.id ?? list[0]?.id ?? null;
  const canPlace = data.items.length > 0 && data.blockers.length === 0 && selected !== null && !placing;

  async function placeOrder() {
    if (!selected) return;
    setPlacing(true);
    setError(null);
    try {
      const order = await apiRequest<Order>('/api/v1/patients/me/orders', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: { addressId: selected, paymentMethod: payment },
      });
      navigate(`/orders/${order.id}`, { state: { justPlaced: true, replayed: order.replayed === true } });
    } catch (err) {
      // The key is kept, so pressing the button again is a safe retry.
      setError(err instanceof ApiError && err.code === 'NETWORK_ERROR' ? 'The connection dropped. Press Place order again; your order will not be duplicated.' : messageOf(err));
    } finally {
      setPlacing(false);
    }
  }

  return (
    <div className="space-y-8">
      <Hero role="PATIENT" title="Checkout" subtitle="Choose where to deliver and how to pay. Your total is fixed when you place the order." />
      {data.items.length === 0 ? (
        <Card className="mx-auto max-w-lg text-center">
          <p className="font-semibold text-ink">Your cart is empty</p>
          <Link to="/medicines" className="mt-3 inline-block text-sm font-semibold text-teal-700 hover:underline">Browse medicines</Link>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Card title="Delivery address" description="Pick a saved address or add a new one.">
              {list.length === 0 && !adding && <p className="text-sm text-slate-600">No saved addresses yet.</p>}
              <div role="radiogroup" aria-label="Delivery address" className="grid gap-3 sm:grid-cols-2">
                {list.map((a) => (
                  <label key={a.id} className={`cursor-pointer rounded-2xl p-4 text-sm ring-1 transition ${selected === a.id ? 'bg-teal-50 ring-teal-500' : 'bg-white ring-slate-200 hover:ring-teal-300'}`}>
                    <input type="radio" name="address" value={a.id} checked={selected === a.id} onChange={() => setAddressId(a.id)} className="sr-only" />
                    <span className="flex items-center gap-2 font-semibold text-ink"><MapPin className="size-4 text-teal-700" aria-hidden="true" />{a.label}</span>
                    <span className="mt-1 block text-slate-600">{a.line}, {a.city}, {a.state} {a.pincode}</span>
                  </label>
                ))}
              </div>
              {adding ? (
                <AddressFormView
                  onSaved={async (a) => {
                    await addresses.reload();
                    setAddressId(a.id);
                    setAdding(false);
                  }}
                  onCancel={() => setAdding(false)}
                />
              ) : (
                <Button variant="secondary" className="mt-4" onClick={() => setAdding(true)}>
                  <Plus className="size-4" aria-hidden="true" /> Add address
                </Button>
              )}
            </Card>

            <Card title="Payment" description="Card payments are simulated in this demo. Cash on delivery is collected when the order is delivered.">
              <fieldset className="grid gap-3 sm:grid-cols-2">
                <legend className="sr-only">Payment method</legend>
                <PaymentOption checked={payment === 'MOCK_CARD'} onSelect={() => setPayment('MOCK_CARD')} icon={CreditCard} label="Card (simulated)" hint="Paid when you place the order" />
                <PaymentOption checked={payment === 'COD'} onSelect={() => setPayment('COD')} icon={Wallet} label="Cash on delivery" hint="Pay the delivery agent" />
              </fieldset>
            </Card>
          </div>

          <aside className="space-y-4">
            <Card title="Order summary">
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-slate-600">Subtotal</dt><dd className="font-medium">{inr(data.summary.subtotalInr)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-600">Prescription discount</dt><dd className="font-medium">{data.summary.discountInr > 0 ? `− ${inr(data.summary.discountInr)}` : inr(0)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-600">Delivery</dt><dd className="font-medium">{data.summary.freeDelivery ? 'Free' : inr(data.summary.deliveryFeeInr)}</dd></div>
                <div className="flex justify-between border-t border-slate-100 pt-3 text-base font-bold text-ink"><dt>Total</dt><dd>{inr(data.summary.totalInr)}</dd></div>
              </dl>
              <ul className="mt-4 space-y-1 text-xs text-slate-500">
                {data.summary.explanation.map((e) => <li key={e}>{e}</li>)}
              </ul>
            </Card>
            {data.blockers.length > 0 && (
              <p role="alert" className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">Fix these in your cart first: {data.blockers.join('; ')}.</p>
            )}
            {error && <p role="alert" className="rounded-2xl bg-rose-50 p-4 text-sm text-rose-800">{error}</p>}
            <Button className="w-full" disabled={!canPlace} loading={placing} onClick={placeOrder}>
              Place order
            </Button>
          </aside>
        </div>
      )}
    </div>
  );
}

function PaymentOption({ checked, onSelect, icon: Icon, label, hint }: { checked: boolean; onSelect: () => void; icon: typeof CreditCard; label: string; hint: string }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-2xl p-4 ring-1 transition ${checked ? 'bg-indigo-50 ring-indigo-500' : 'bg-white ring-slate-200 hover:ring-indigo-300'}`}>
      <input type="radio" name="payment" checked={checked} onChange={onSelect} className="mt-1" />
      <Icon className="mt-0.5 size-5 text-indigo-700" aria-hidden="true" />
      <span>
        <span className="block font-semibold text-ink">{label}</span>
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
    </label>
  );
}

function AddressFormView({ onSaved, onCancel }: { onSaved: (a: Address) => Promise<void>; onCancel: () => void }) {
  const [form, setForm] = useState<AddressForm>(EMPTY_ADDRESS);
  const [errors, setErrors] = useState<Partial<Record<keyof AddressForm, string>>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (form.label.trim().length < 1) next.label = 'Give this address a name';
    if (form.line.trim().length < 5) next.line = 'Enter the street address';
    if (form.city.trim().length < 2) next.city = 'Enter the city';
    if (form.state.trim().length < 2) next.state = 'Enter the state';
    if (!PINCODE.test(form.pincode)) next.pincode = 'Enter a 6-digit pincode';
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    setMessage(null);
    try {
      const saved = await apiRequest<Address>('/api/v1/patients/me/addresses', { method: 'POST', body: { ...form, isDefault: false } });
      await onSaved(saved);
    } catch (err) {
      setMessage(messageOf(err));
    } finally {
      setSaving(false);
    }
  }

  const set = (key: keyof AddressForm) => (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });
  return (
    <form onSubmit={submit} noValidate aria-label="New address" className="mt-4 grid gap-4 rounded-2xl bg-slate-50 p-5 ring-1 ring-slate-200 sm:grid-cols-2">
      <Input label="Label" value={form.label} onChange={set('label')} error={errors.label} />
      <Input label="Pincode" inputMode="numeric" value={form.pincode} onChange={set('pincode')} error={errors.pincode} />
      <div className="sm:col-span-2"><Input label="Street address" value={form.line} onChange={set('line')} error={errors.line} /></div>
      <Input label="City" value={form.city} onChange={set('city')} error={errors.city} />
      <Input label="State" value={form.state} onChange={set('state')} error={errors.state} />
      {message && <p role="alert" className="text-sm text-rose-700 sm:col-span-2">{message}</p>}
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={saving}>Save address</Button>
      </div>
    </form>
  );
}
