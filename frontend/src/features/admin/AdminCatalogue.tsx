import { useEffect, useState, type FormEvent } from 'react';
import { Pencil, Plus, PowerOff } from 'lucide-react';
import { PageLoader } from '../../components/PageLoader';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import { useToast } from '../../components/ui/Toast';
import { ApiError, apiRequest } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import { messageOf, useApi } from '../../lib/useApi';
import type { PageMeta } from '../../types/clinical';
import { AVAILABILITY_LABEL, AVAILABILITY_TONE, type AdminMedicine } from '../catalogue/types';
import { Hero } from '../dashboards/RoleDashboard';

interface FormState {
  sku: string;
  name: string;
  strength: string;
  form: string;
  category: string;
  packSize: string;
  priceInr: string;
  rxRequired: boolean;
  allergyClass: string;
  description: string;
  manufacturer: string;
  chronicEligible: boolean;
  initialStock: string;
  active: boolean;
}

const EMPTY: FormState = {
  sku: '', name: '', strength: '', form: '', category: '', packSize: '', priceInr: '', rxRequired: false,
  allergyClass: '', description: '', manufacturer: '', chronicEligible: false, initialStock: '0', active: true,
};

const fromMedicine = (m: AdminMedicine): FormState => ({
  sku: m.sku,
  name: m.name,
  strength: m.strength ?? '',
  form: m.form,
  category: m.category,
  packSize: m.packSize,
  priceInr: String(m.priceInr),
  rxRequired: m.rxRequired,
  allergyClass: m.allergyClass ?? '',
  description: m.description ?? '',
  manufacturer: m.manufacturer ?? '',
  chronicEligible: m.chronicEligible,
  initialStock: '0',
  active: m.active,
});

/** Returns the first problem as a message, or null. The server re-validates everything. */
function problemWith(f: FormState, creating: boolean): string | null {
  if (creating && !/^[A-Za-z0-9-]{3,32}$/.test(f.sku.trim())) return 'SKU: 3 to 32 letters, digits or hyphens';
  if (f.name.trim().length < 2) return 'Enter the medicine name';
  if (f.form.trim().length < 2) return 'Enter the form, for example Tablet';
  if (f.category.trim().length < 2) return 'Enter the category, for example Antibiotic';
  if (f.packSize.trim().length < 2) return 'Enter the pack size, for example Strip of 10';
  const price = Number(f.priceInr);
  if (f.priceInr.trim() === '' || !Number.isFinite(price) || price < 0 || price > 100000) return 'Price must be between 0 and 100,000';
  if (creating) {
    const stock = Number(f.initialStock);
    if (!Number.isInteger(stock) || stock < 0) return 'Opening stock must be a whole number, 0 or more';
  }
  return null;
}

function bodyOf(f: FormState, creating: boolean) {
  const base = {
    name: f.name.trim(),
    strength: f.strength.trim(),
    form: f.form.trim(),
    category: f.category.trim(),
    packSize: f.packSize.trim(),
    priceInr: Number(f.priceInr),
    rxRequired: f.rxRequired,
    allergyClass: f.allergyClass.trim(),
    description: f.description.trim(),
    manufacturer: f.manufacturer.trim(),
    chronicEligible: f.chronicEligible,
    active: f.active,
  };
  return creating ? { ...base, sku: f.sku.trim().toUpperCase(), initialStock: Number(f.initialStock) } : base;
}

/** Admin: the medicine catalogue. Writes go to PostgreSQL first; search indexing follows through the outbox. */
export default function AdminCatalogue() {
  const toast = useToast();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [active, setActive] = useState<'all' | 'true' | 'false'>('all');
  const [editing, setEditing] = useState<AdminMedicine | 'new' | null>(null);
  const [deactivating, setDeactivating] = useState<AdminMedicine | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const qs = new URLSearchParams({ pageSize: '50', active });
  if (q) qs.set('q', q);
  const list = useApi<{ items: AdminMedicine[]; meta: PageMeta }>(`/api/v1/admin/medicines?${qs}`);

  return (
    <div className="space-y-8">
      <Hero role="ADMIN" title="Medicine catalogue" subtitle="Create, correct and retire medicines. Stock changes are made by pharmacy, not here." />

      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-60 flex-1">
            <Input label="Search" type="search" placeholder="Name or SKU" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="w-48">
            <Select
              label="Status"
              value={active}
              onChange={(e) => setActive(e.target.value as 'all' | 'true' | 'false')}
              options={[{ value: 'all', label: 'All' }, { value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]}
            />
          </div>
          <Button onClick={() => setEditing('new')}><Plus className="size-4" aria-hidden="true" /> New medicine</Button>
        </div>
      </Card>

      {list.loading && <PageLoader label="Loading catalogue" />}
      {list.error && <p role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-800">{list.error}</p>}
      {list.data && list.data.items.length === 0 && <p className="text-sm text-slate-500">No medicines match.</p>}
      {list.data && list.data.items.length > 0 && (
        <div className="overflow-x-auto rounded-2xl bg-white/90 shadow-sm ring-1 ring-slate-900/5">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-3">SKU</th>
                <th scope="col" className="px-4 py-3">Medicine</th>
                <th scope="col" className="px-4 py-3">Category</th>
                <th scope="col" className="px-4 py-3">Price</th>
                <th scope="col" className="px-4 py-3">Stock</th>
                <th scope="col" className="px-4 py-3">Status</th>
                <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.data.items.map((m) => (
                <tr key={m.id} className={m.active ? '' : 'text-slate-500'}>
                  <td className="px-4 py-3">{m.sku}</td>
                  <td className="px-4 py-3 font-medium text-ink">{m.name}{m.rxRequired ? ' · Rx' : ''}{m.chronicEligible ? ' · chronic' : ''}</td>
                  <td className="px-4 py-3">{m.category}</td>
                  <td className="px-4 py-3 tabular-nums">{formatMoney(m.priceInr)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${AVAILABILITY_TONE[m.availability]}`}>{m.stockQty} · {AVAILABILITY_LABEL[m.availability]}</span>
                  </td>
                  <td className="px-4 py-3">{m.active ? 'Active' : 'Inactive'}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <Button variant="secondary" className="min-h-9 px-3" onClick={() => setEditing(m)}><Pencil className="size-4" aria-hidden="true" /> Edit</Button>
                      {m.active && (
                        <Button variant="ghost" className="min-h-9 px-3" onClick={() => setDeactivating(m)}><PowerOff className="size-4" aria-hidden="true" /> Deactivate</Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <MedicineForm
          key={editing === 'new' ? 'new' : editing.id}
          medicine={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
          notify={toast.notify}
        />
      )}

      <Modal open={deactivating !== null} title="Deactivate this medicine?" onClose={() => setDeactivating(null)}>
        <div className="space-y-4 text-sm">
          <p className="text-slate-700">{deactivating?.name} will stop appearing in the catalogue and search. Existing prescriptions keep it.</p>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setDeactivating(null)}>Keep it active</Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!deactivating) return;
                try {
                  await apiRequest(`/api/v1/admin/medicines/${deactivating.id}/deactivate`, { method: 'POST' });
                  toast.notify('success', `${deactivating.name} deactivated`);
                  setDeactivating(null);
                  list.reload();
                } catch (err) {
                  toast.notify('error', err instanceof ApiError ? err.message : messageOf(err));
                }
              }}
            >
              Deactivate
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function MedicineForm({
  medicine,
  onCancel,
  onSaved,
  notify,
}: {
  medicine: AdminMedicine | null;
  onCancel: () => void;
  onSaved: () => void;
  notify: (kind: 'success' | 'error', message: string) => void;
}) {
  const creating = medicine === null;
  const [f, setF] = useState<FormState>(medicine ? fromMedicine(medicine) : EMPTY);
  const [problem, setProblem] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<{ path?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setF((prev) => ({ ...prev, [key]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = problemWith(f, creating);
    setProblem(p);
    setServerErrors([]);
    if (p) return;
    setBusy(true);
    try {
      if (creating) await apiRequest('/api/v1/admin/medicines', { method: 'POST', body: bodyOf(f, true) });
      else await apiRequest(`/api/v1/admin/medicines/${medicine.id}`, { method: 'PATCH', body: bodyOf(f, false) });
      notify('success', creating ? 'Medicine created' : 'Medicine updated');
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) setServerErrors(err.details.length ? err.details : [{ message: err.message }]);
      else setServerErrors([{ message: messageOf(err) }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={creating ? 'New medicine' : `Edit ${medicine.name}`} description="Changes to name, price, category or Rx flag are reflected in search within moments.">
      <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
        <Input label="SKU" value={f.sku} disabled={!creating} onChange={(e) => set('sku', e.target.value)} hint={creating ? 'Permanent identifier, for example MED-2001' : 'SKU cannot be changed'} />
        <Input label="Name" value={f.name} onChange={(e) => set('name', e.target.value)} />
        <Input label="Strength" value={f.strength} onChange={(e) => set('strength', e.target.value)} />
        <Input label="Form" value={f.form} onChange={(e) => set('form', e.target.value)} placeholder="Tablet" />
        <Input label="Category" value={f.category} onChange={(e) => set('category', e.target.value)} placeholder="Antibiotic" />
        <Input label="Pack size" value={f.packSize} onChange={(e) => set('packSize', e.target.value)} placeholder="Strip of 10" />
        <Input label="Price (₹)" type="number" inputMode="decimal" min={0} value={f.priceInr} onChange={(e) => set('priceInr', e.target.value)} />
        <Input label="Allergy class (optional)" value={f.allergyClass} onChange={(e) => set('allergyClass', e.target.value)} hint="Used for the allergy check. Exact match only." />
        <Input label="Manufacturer (optional)" value={f.manufacturer} onChange={(e) => set('manufacturer', e.target.value)} />
        {creating && <Input label="Opening stock" type="number" inputMode="numeric" min={0} value={f.initialStock} onChange={(e) => set('initialStock', e.target.value)} />}
        <div className="sm:col-span-2 space-y-1.5">
          <label htmlFor="med-description" className="block text-sm font-medium text-ink">Description (optional)</label>
          <textarea id="med-description" rows={3} maxLength={1000} value={f.description} onChange={(e) => set('description', e.target.value)} className="block w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm shadow-sm focus:border-teal-500 focus:outline-none focus:ring-4 focus:ring-teal-500/15" />
        </div>
        <fieldset className="sm:col-span-2 flex flex-wrap gap-6 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.rxRequired} onChange={(e) => set('rxRequired', e.target.checked)} /> Prescription required (Rx)</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.chronicEligible} onChange={(e) => set('chronicEligible', e.target.checked)} /> Eligible for 90-day chronic validity</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Active in catalogue</label>
        </fieldset>

        {problem && <p role="alert" className="sm:col-span-2 text-sm font-medium text-rose-600">{problem}</p>}
        {serverErrors.length > 0 && (
          <div role="alert" className="sm:col-span-2 rounded-xl bg-rose-50 p-4 text-sm text-rose-900">
            {serverErrors.map((d) => <p key={`${d.path ?? ''}${d.message}`}>{d.message}</p>)}
          </div>
        )}
        <div className="sm:col-span-2 flex justify-end gap-3">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button type="submit" loading={busy}>{creating ? 'Create medicine' : 'Save changes'}</Button>
        </div>
      </form>
    </Card>
  );
}
