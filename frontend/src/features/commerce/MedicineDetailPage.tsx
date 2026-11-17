import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ShoppingCart } from 'lucide-react';
import { PageLoader } from '../../components/PageLoader';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { useToast } from '../../components/ui/Toast';
import { useAuth } from '../../lib/auth-context';
import { apiRequest } from '../../lib/api';
import { messageOf, useApi } from '../../lib/useApi';
import { AVAILABILITY_LABEL, AVAILABILITY_TONE, type PublicMedicine } from '../catalogue/types';
import { inr } from './types';

/** Public medicine detail. Only patients can add to the cart; prescription medicines are bought from a prescription. */
export function MedicineDetailPage() {
  const { medicineId = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const medicine = useApi<PublicMedicine>(`/api/v1/catalogue/medicines/${medicineId}`);
  const [quantity, setQuantity] = useState(1);
  const [adding, setAdding] = useState(false);

  if (medicine.loading) return <PageLoader label="Loading medicine" />;
  if (medicine.error || !medicine.data) {
    return (
      <Card className="mx-auto max-w-lg text-center">
        <p role="alert" className="text-sm font-medium text-ink">{medicine.error ?? 'This medicine is not available.'}</p>
        <Link to="/medicines" className="mt-4 inline-block text-sm font-semibold text-teal-700 hover:underline">Back to the catalogue</Link>
      </Card>
    );
  }
  const m = medicine.data;
  const isPatient = user?.role === 'PATIENT';

  async function addToCart() {
    setAdding(true);
    try {
      await apiRequest('/api/v1/patients/me/cart/items', { method: 'POST', body: { medicineId: m.id, quantity } });
      toast.notify('success', `${m.name} added to your cart`);
      navigate('/cart');
    } catch (err) {
      toast.notify('error', messageOf(err));
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link to="/medicines" className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-800 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Back to the catalogue
      </Link>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{m.category}</p>
            <h1 className="text-2xl font-bold tracking-tight text-ink">{m.name}</h1>
            <p className="text-sm text-slate-600">{[m.strength, m.form, m.packSize].filter(Boolean).join(' · ')}</p>
            <p className="text-xs text-slate-500">SKU {m.sku}{m.manufacturer ? ` · ${m.manufacturer}` : ''}</p>
          </div>
          <div className="space-y-2 text-right">
            <p className="text-2xl font-bold text-ink">{inr(m.priceInr)}</p>
            <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${m.rxRequired ? 'bg-indigo-50 text-indigo-800 ring-indigo-200' : 'bg-slate-50 text-slate-700 ring-slate-200'}`}>
              {m.rxRequired ? 'Prescription medicine' : 'Over the counter'}
            </span>
            <p className={`text-xs font-semibold ${AVAILABILITY_TONE[m.availability]}`}>{AVAILABILITY_LABEL[m.availability]}</p>
          </div>
        </div>
        {m.description && <p className="mt-5 text-sm leading-relaxed text-slate-700">{m.description}</p>}
        {m.allergyClass && <p className="mt-3 text-xs text-slate-500">Allergy class: {m.allergyClass}</p>}
      </Card>

      <Card title="Buy">
        {m.rxRequired ? (
          <p className="text-sm text-indigo-900">Prescription required: buy it from a valid prescription. Open the prescription from your Prescriptions page and choose Buy these medicines.</p>
        ) : m.availability === 'OUT_OF_STOCK' ? (
          <p className="text-sm text-rose-700">Out of stock right now.</p>
        ) : isPatient ? (
          <div className="flex flex-wrap items-end gap-4">
            <label className="space-y-1.5 text-sm font-medium text-ink">
              Quantity
              <input
                type="number"
                min={1}
                max={100}
                value={quantity}
                onChange={(e) => setQuantity(Math.min(100, Math.max(1, Math.trunc(Number(e.target.value) || 1))))}
                className="block w-28 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              />
            </label>
            <Button loading={adding} onClick={addToCart}>
              <ShoppingCart className="size-4" aria-hidden="true" /> Add to cart
            </Button>
          </div>
        ) : (
          <p className="text-sm text-slate-700">
            <Link to="/login" className="font-semibold text-teal-700 hover:underline">Sign in as a patient</Link> to add this medicine to your cart.
          </p>
        )}
      </Card>
    </div>
  );
}
