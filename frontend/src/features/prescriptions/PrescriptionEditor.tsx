import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Eye, Pill, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Input';
import { useToast } from '../../components/ui/Toast';
import { apiRequest } from '../../lib/api';
import { messageOf, useApi } from '../../lib/useApi';
import type { PageMeta } from '../../types/clinical';
import type { DrugInteraction, MedicineOption, Prescription } from './types';

interface MedicinesResponse {
  items: MedicineOption[];
  meta: PageMeta;
}

interface LineForm {
  dose: string;
  frequency: string;
  durationDays: string;
  quantity: string;
  instructions: string;
}

const EMPTY_LINE: LineForm = { dose: '', frequency: '', durationDays: '', quantity: '', instructions: '' };

function lineErrors(f: LineForm): Partial<Record<keyof LineForm, string>> {
  const e: Partial<Record<keyof LineForm, string>> = {};
  if (!f.dose.trim()) e.dose = 'Enter the dose, for example 500 mg';
  if (!f.frequency.trim()) e.frequency = 'Enter how often, for example twice a day';
  const d = Number(f.durationDays);
  if (f.durationDays === '' || !Number.isInteger(d) || d < 1 || d > 365) e.durationDays = 'Whole days from 1 to 365';
  const q = Number(f.quantity);
  if (f.quantity === '' || !Number.isInteger(q) || q < 1 || q > 100) e.quantity = 'Whole number from 1 to 100';
  return e;
}

/** Draft editor: pick medicines from the catalogue, set dose, frequency, duration and quantity, then preview. */
export function PrescriptionEditor({ rx, onChanged }: { rx: Prescription; onChanged: (next: Prescription) => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<MedicineOption | null>(null);
  const [line, setLine] = useState<LineForm>(EMPTY_LINE);
  const [errors, setErrors] = useState<Partial<Record<keyof LineForm, string>>>({});
  const [busy, setBusy] = useState(false);
  const [advice, setAdvice] = useState(rx.advice ?? '');
  const [validityBusy, setValidityBusy] = useState(false);
  const interactions: DrugInteraction[] = rx.checks?.interactions ?? [];
  const majors = interactions.filter((i) => i.severity === 'MAJOR');
  const others = interactions.filter((i) => i.severity !== 'MAJOR');
  const notEligible = rx.checks?.notChronicEligible ?? [];
  const medicines = useApi<MedicinesResponse>(`/api/v1/medicines?pageSize=8${query ? `&query=${encodeURIComponent(query)}` : ''}`);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const matches = rx.checks?.allergyMatches ?? [];

  async function addLine(e: FormEvent) {
    e.preventDefault();
    if (!picked) return setErrors({ dose: 'Choose a medicine first' });
    const v = lineErrors(line);
    setErrors(v);
    if (Object.keys(v).length) return;
    setBusy(true);
    try {
      const updated = await apiRequest<Prescription>(`/api/v1/doctor/prescriptions/${rx.id}/items`, {
        method: 'POST',
        body: {
          medicineId: picked.id,
          dose: line.dose.trim(),
          frequency: line.frequency.trim(),
          durationDays: Number(line.durationDays),
          quantity: Number(line.quantity),
          instructions: line.instructions.trim() || null,
        },
      });
      onChanged(updated);
      setPicked(null);
      setLine(EMPTY_LINE);
      toast.notify('success', `${picked.name} added`);
    } catch (err) {
      setErrors({ dose: messageOf(err) });
    } finally {
      setBusy(false);
    }
  }

  async function removeLine(itemId: string) {
    setBusy(true);
    try {
      onChanged(await apiRequest<Prescription>(`/api/v1/doctor/prescriptions/${rx.id}/items/${itemId}`, { method: 'DELETE' }));
    } catch (err) {
      toast.notify('error', messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function setValidity(days: 30 | 90) {
    setValidityBusy(true);
    try {
      onChanged(await apiRequest<Prescription>(`/api/v1/doctor/prescriptions/${rx.id}`, { method: 'PATCH', body: { validityDays: days } }));
    } catch (err) {
      toast.notify('error', messageOf(err));
    } finally {
      setValidityBusy(false);
    }
  }

  async function saveAdvice() {
    try {
      onChanged(await apiRequest<Prescription>(`/api/v1/doctor/prescriptions/${rx.id}`, { method: 'PATCH', body: { advice: advice.trim() || null } }));
      toast.notify('success', 'Advice saved');
    } catch (err) {
      toast.notify('error', messageOf(err));
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        {matches.length > 0 && (
          <div role="alert" className="flex gap-4 rounded-2xl border border-rose-300 bg-rose-50 p-5">
            <AlertTriangle className="mt-0.5 size-6 shrink-0 text-rose-600" aria-hidden="true" />
            <div className="space-y-1 text-sm text-rose-900">
              <p className="font-semibold">Allergy conflict: this prescription cannot be issued</p>
              {matches.map((m) => (
                <p key={m.medicineSku}>{m.medicineName} is class {m.allergyClass}, which matches a recorded allergy. Remove it or choose an alternative.</p>
              ))}
            </div>
          </div>
        )}

        {majors.length > 0 && (
          <div role="alert" className="flex gap-4 rounded-2xl border border-rose-300 bg-rose-50 p-5">
            <AlertTriangle className="mt-0.5 size-6 shrink-0 text-rose-600" aria-hidden="true" />
            <div className="space-y-1 text-sm text-rose-900">
              <p className="font-semibold">Major drug interaction: this prescription cannot be issued</p>
              {majors.map((i) => (
                <p key={i.medicines.map((m) => m.id).join('-')}>
                  {i.medicines.map((m) => m.name).join(' + ')}: {i.effect} <span className="text-xs">(source: {i.sourceReference})</span>
                </p>
              ))}
            </div>
          </div>
        )}
        {others.length > 0 && (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">
            <p className="font-semibold">Drug interaction notes</p>
            <ul className="mt-1 space-y-1">
              {others.map((i) => (
                <li key={i.medicines.map((m) => m.id).join('-')}>
                  <span className="font-medium">{i.severity === 'MODERATE' ? 'Moderate' : 'Minor'}:</span> {i.medicines.map((m) => m.name).join(' + ')}. {i.effect} <span className="text-xs">(source: {i.sourceReference})</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <Card title="Add a medicine" description="Search the catalogue, then set the dose, frequency, duration and quantity.">
          <div className="space-y-5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <input
                type="search"
                aria-label="Search medicines"
                placeholder="Search by name or code, e.g. amoxicillin"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="min-h-11 w-full rounded-xl border border-slate-200 bg-white/90 pl-11 pr-4 text-sm"
              />
            </div>
            {medicines.loading && <p role="status" className="text-sm text-slate-500">Searching…</p>}
            {medicines.error && <p role="alert" className="text-sm text-rose-700">{medicines.error}</p>}
            {medicines.data && medicines.data.items.length === 0 && <p className="text-sm text-slate-500">No medicines match.</p>}
            <ul className="grid gap-2 sm:grid-cols-2">
              {medicines.data?.items.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    aria-pressed={picked?.id === m.id}
                    onClick={() => setPicked(m)}
                    className={`w-full rounded-xl p-3 text-left text-sm transition ${picked?.id === m.id ? 'bg-indigo-600 text-white shadow-md' : 'bg-white ring-1 ring-slate-200 hover:ring-indigo-300'}`}
                  >
                    <span className="block font-semibold">{m.name}</span>
                    <span className={`block text-xs ${picked?.id === m.id ? 'text-indigo-100' : 'text-slate-500'}`}>
                      {m.sku} · {m.rxRequired ? 'Rx' : 'OTC'}{m.allergyClass ? ` · class ${m.allergyClass}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {picked && (
              <form onSubmit={addLine} noValidate className="grid gap-4 rounded-2xl bg-indigo-50/60 p-5 ring-1 ring-indigo-100 sm:grid-cols-2">
                <p className="sm:col-span-2 text-sm font-semibold text-indigo-900">{picked.name}</p>
                <Input label="Dose" placeholder="500 mg" value={line.dose} onChange={(e) => setLine({ ...line, dose: e.target.value })} error={errors.dose} />
                <Input label="Frequency" placeholder="Twice a day" value={line.frequency} onChange={(e) => setLine({ ...line, frequency: e.target.value })} error={errors.frequency} />
                <Input label="Duration (days)" inputMode="numeric" value={line.durationDays} onChange={(e) => setLine({ ...line, durationDays: e.target.value })} error={errors.durationDays} />
                <Input label="Quantity" inputMode="numeric" value={line.quantity} onChange={(e) => setLine({ ...line, quantity: e.target.value })} error={errors.quantity} hint={`Units dispensed (pack: ${picked.packSize})`} />
                <div className="sm:col-span-2">
                  <Input label="Instructions (optional)" placeholder="After food" value={line.instructions} onChange={(e) => setLine({ ...line, instructions: e.target.value })} />
                </div>
                <div className="sm:col-span-2 flex justify-end">
                  <Button type="submit" loading={busy}><Plus className="size-4" aria-hidden="true" /> Add to prescription</Button>
                </div>
              </form>
            )}
          </div>
        </Card>
      </div>

      <aside className="space-y-6">
        <Card title={`Medicines on this draft (${rx.items.length})`}>
          {rx.items.length === 0 && <p className="text-sm text-slate-500">Nothing added yet.</p>}
          <ul className="divide-y divide-slate-100">
            {rx.items.map((it) => (
              <li key={it.id} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-semibold text-ink"><Pill className="size-4 text-indigo-600" aria-hidden="true" />{it.medicine.name}</p>
                    <p className="text-xs text-slate-500">{it.dose} · {it.frequency} · {it.durationDays} day{it.durationDays === 1 ? '' : 's'} · qty {it.quantity}</p>
                    {it.instructions && <p className="text-xs text-slate-500">{it.instructions}</p>}
                  </div>
                  <button type="button" aria-label={`Remove ${it.medicine.name}`} onClick={() => removeLine(it.id)} disabled={busy} className="rounded-lg p-2 text-slate-500 hover:bg-rose-50 hover:text-rose-700">
                    <Trash2 className="size-4" aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Advice to patient">
          <textarea aria-label="Advice to patient" rows={3} maxLength={500} value={advice} onChange={(e) => setAdvice(e.target.value)} className="block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
          <div className="mt-3 flex justify-end">
            <Button variant="secondary" onClick={saveAdvice}>Save advice</Button>
          </div>
        </Card>

        <Card title="Next step">
          {rx.checks && !rx.checks.canIssue && (
            <ul className="mb-4 space-y-1 text-sm text-amber-900">
              {rx.checks.blockers.map((b) => <li key={b}>• {b}</li>)}
            </ul>
          )}
          <div className="mb-5 space-y-2">
            <p className="text-sm font-medium text-ink">Validity</p>
            <div role="group" aria-label="Validity" className="flex gap-2">
              {([30, 90] as const).map((days) => {
                const blocked = days === 90 && notEligible.length > 0;
                return (
                  <button
                    key={days}
                    type="button"
                    aria-pressed={rx.validityDays === days}
                    disabled={validityBusy || blocked}
                    onClick={() => setValidity(days)}
                    className={`min-h-10 flex-1 rounded-xl px-3 text-sm font-semibold ring-1 transition disabled:opacity-50 ${rx.validityDays === days ? 'bg-teal-600 text-white ring-teal-600' : 'bg-white text-ink ring-slate-200 hover:ring-teal-300'}`}
                  >
                    {days} days
                  </button>
                );
              })}
            </div>
            {notEligible.length > 0 && (
              <p className="text-xs text-slate-500">90 days is only for chronic-eligible medicines. Not eligible: {notEligible.map((m) => m.name).join(', ')}.</p>
            )}
          </div>
          <Button className="w-full" onClick={() => navigate(`/doctor/prescriptions/${rx.id}/preview`)} disabled={rx.items.length === 0}>
            <Eye className="size-4" aria-hidden="true" /> Preview prescription
          </Button>
        </Card>
      </aside>
    </div>
  );
}
