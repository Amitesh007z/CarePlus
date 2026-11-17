import { useState, type FormEvent } from 'react';
import { Plus, ShieldCheck, ShieldOff, Pill } from 'lucide-react';
import { PageLoader } from '../../components/PageLoader';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { useToast } from '../../components/ui/Toast';
import { apiRequest } from '../../lib/api';
import { formatDay } from '../../lib/format';
import { messageOf, useApi } from '../../lib/useApi';
import { SEVERITY_OPTIONS, type HealthItem, type Medication, type PageMeta } from '../../types/clinical';
import type { PatientInfo } from '../../types/auth';
import { Hero } from '../dashboards/RoleDashboard';

interface ProfileResponse {
  profile: PatientInfo | null;
}
interface HealthResponse {
  items: HealthItem[];
  meta: PageMeta;
}
interface MedsResponse {
  items: Medication[];
  meta: PageMeta;
}

const today = () => new Date().toISOString().slice(0, 10);

export default function HealthPage() {
  const toast = useToast();
  const profile = useApi<ProfileResponse>('/api/v1/patients/me');
  const health = useApi<HealthResponse>('/api/v1/patients/me/health-info?pageSize=100');
  const meds = useApi<MedsResponse>('/api/v1/patients/me/medications?pageSize=100');
  const [consentBusy, setConsentBusy] = useState(false);

  if (profile.loading || health.loading || meds.loading) return <PageLoader label="Loading your health profile" />;
  const error = profile.error ?? health.error ?? meds.error;
  if (error) return <p role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-800">{error}</p>;

  const consented = profile.data?.profile?.consentStatus ?? false;
  const items = health.data?.items ?? [];

  async function setConsent(granted: boolean) {
    setConsentBusy(true);
    try {
      await apiRequest('/api/v1/patients/me/consent', { method: 'POST', body: { granted } });
      toast.notify('success', granted ? 'Consent granted. Thank you.' : 'Consent withdrawn. Doctors can no longer see your health details.');
      profile.reload();
    } catch (err) {
      toast.notify('error', messageOf(err));
    } finally {
      setConsentBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <Hero role="PATIENT" title="Health & privacy" subtitle="Your allergies, conditions and medicines help doctors keep you safe. You control who sees them." />

      <Card
        title="Health-data consent"
        description={consented ? 'Your treating doctors can see your health details.' : 'Consent is off. Doctors cannot see your health details.'}
        actions={
          consented ? (
            <Button variant="secondary" loading={consentBusy} onClick={() => setConsent(false)}>
              <ShieldOff className="size-4" aria-hidden="true" /> Withdraw consent
            </Button>
          ) : (
            <Button loading={consentBusy} onClick={() => setConsent(true)}>
              <ShieldCheck className="size-4" aria-hidden="true" /> Grant consent
            </Button>
          )
        }
      >
        <ul className="grid gap-3 text-sm text-slate-600 sm:grid-cols-2">
          <li className="rounded-xl bg-slate-50 p-3">New allergies, conditions and medicines are saved only while consent is on.</li>
          <li className="rounded-xl bg-slate-50 p-3">Withdrawing hides your health details from doctors straight away. Your records are kept.</li>
          <li className="rounded-xl bg-slate-50 p-3">Appointments you already booked stay. You can still cancel or reschedule them.</li>
          <li className="rounded-xl bg-slate-50 p-3">You can always view and edit your own records, whatever your consent state.</li>
        </ul>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <HealthSection type="ALLERGY" title="Allergies" items={items.filter((i) => i.type === 'ALLERGY')} consented={consented} onChanged={health.reload} />
        <HealthSection type="CONDITION" title="Chronic conditions" items={items.filter((i) => i.type === 'CONDITION')} consented={consented} onChanged={health.reload} />
      </div>

      <MedicationsSection items={meds.data?.items ?? []} consented={consented} onChanged={meds.reload} />
    </div>
  );
}

function HealthSection({ type, title, items, consented, onChanged }: { type: 'ALLERGY' | 'CONDITION'; title: string; items: HealthItem[]; consented: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [allergyClass, setAllergyClass] = useState('');
  const [severity, setSeverity] = useState('');
  const [notedOn, setNotedOn] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return setError('Enter a name (at least 2 characters)');
    setSaving(true);
    setError(null);
    try {
      await apiRequest('/api/v1/patients/me/health-info', {
        method: 'POST',
        body: {
          type,
          name: name.trim(),
          allergyClass: type === 'ALLERGY' && allergyClass.trim() ? allergyClass.trim() : null,
          severity: severity || null,
          notedOn,
        },
      });
      toast.notify('success', `${type === 'ALLERGY' ? 'Allergy' : 'Condition'} saved`);
      setName('');
      setAllergyClass('');
      setSeverity('');
      setAdding(false);
      onChanged();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggle(item: HealthItem) {
    try {
      await apiRequest(`/api/v1/patients/me/health-info/${item.id}`, { method: 'PATCH', body: { active: !item.active } });
      onChanged();
    } catch (err) {
      toast.notify('error', messageOf(err));
    }
  }

  return (
    <Card
      title={title}
      description={type === 'ALLERGY' ? 'Checked against every prescription and recommendation.' : 'Long-term conditions your doctor should know about.'}
      actions={
        <Button variant="secondary" onClick={() => setAdding((a) => !a)} disabled={!consented} title={consented ? undefined : 'Grant consent to add records'}>
          <Plus className="size-4" aria-hidden="true" /> Add
        </Button>
      }
    >
      {adding && (
        <form onSubmit={add} noValidate className="mb-5 grid gap-4 rounded-2xl bg-teal-50/60 p-4 ring-1 ring-teal-100 sm:grid-cols-2">
          {error && <p role="alert" className="sm:col-span-2 text-sm text-rose-700">{error}</p>}
          <Input label={type === 'ALLERGY' ? 'Allergen' : 'Condition'} value={name} onChange={(e) => setName(e.target.value)} />
          {type === 'ALLERGY' && <Input label="Allergy class (optional)" value={allergyClass} onChange={(e) => setAllergyClass(e.target.value)} hint="For example: Penicillin" />}
          <Select label="Severity (optional)" placeholder="Not sure" options={SEVERITY_OPTIONS} value={severity} onChange={(e) => setSeverity(e.target.value)} />
          <Input label="Noted on" type="date" max={today()} value={notedOn} onChange={(e) => setNotedOn(e.target.value)} />
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="submit" loading={saving}>Save</Button>
          </div>
        </form>
      )}
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing recorded yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className={`font-medium ${item.active ? 'text-ink' : 'text-slate-400 line-through'}`}>{item.name}</p>
                <p className="text-xs text-slate-500">
                  {item.allergyClass ? `${item.allergyClass} · ` : ''}{item.severity ? `${item.severity.toLowerCase()} · ` : ''}noted {formatDay(`${item.notedOn}T00:00:00+05:30`)}
                </p>
              </div>
              <Button variant="ghost" className="min-h-9 px-3 py-1.5 text-xs" onClick={() => toggle(item)}>
                {item.active ? 'Mark resolved' : 'Reactivate'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function MedicationsSection({ items, consented, onChanged }: { items: Medication[]; consented: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [dose, setDose] = useState('');
  const [frequency, setFrequency] = useState('');
  const [startedOn, setStartedOn] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return setError('Enter the medicine name');
    setSaving(true);
    setError(null);
    try {
      await apiRequest('/api/v1/patients/me/medications', {
        method: 'POST',
        body: { medicationName: name.trim(), dose: dose.trim() || null, frequency: frequency.trim() || null, startedOn },
      });
      toast.notify('success', 'Medicine added');
      setName('');
      setDose('');
      setFrequency('');
      setAdding(false);
      onChanged();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  }

  async function stop(m: Medication) {
    try {
      await apiRequest(`/api/v1/patients/me/medications/${m.id}`, { method: 'PATCH', body: { active: false } });
      toast.notify('success', `${m.medicationName} marked as stopped`);
      onChanged();
    } catch (err) {
      toast.notify('error', messageOf(err));
    }
  }

  const active = items.filter((m) => m.active);
  const stopped = items.filter((m) => !m.active);

  return (
    <Card
      title={<span className="flex items-center gap-2"><Pill className="size-4 text-indigo-600" aria-hidden="true" />Current medicines</span>}
      description="Medicines you take now. Stopped medicines stay in your history."
      actions={
        <Button variant="secondary" onClick={() => setAdding((a) => !a)} disabled={!consented} title={consented ? undefined : 'Grant consent to add medicines'}>
          <Plus className="size-4" aria-hidden="true" /> Add
        </Button>
      }
    >
      {adding && (
        <form onSubmit={add} noValidate className="mb-5 grid gap-4 rounded-2xl bg-indigo-50/60 p-4 ring-1 ring-indigo-100 sm:grid-cols-2">
          {error && <p role="alert" className="sm:col-span-2 text-sm text-rose-700">{error}</p>}
          <Input label="Medicine name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="Dose (optional)" value={dose} onChange={(e) => setDose(e.target.value)} hint="For example: 500 mg" />
          <Input label="How often (optional)" value={frequency} onChange={(e) => setFrequency(e.target.value)} hint="For example: twice a day" />
          <Input label="Started on" type="date" max={today()} value={startedOn} onChange={(e) => setStartedOn(e.target.value)} />
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="submit" loading={saving}>Save</Button>
          </div>
        </form>
      )}
      {active.length === 0 && <p className="text-sm text-slate-500">No current medicines recorded.</p>}
      <ul className="divide-y divide-slate-100">
        {active.map((m) => (
          <li key={m.id} className="flex items-center justify-between gap-3 py-3">
            <div>
              <p className="font-medium text-ink">{m.medicationName}</p>
              <p className="text-xs text-slate-500">{[m.dose, m.frequency].filter(Boolean).join(' · ') || 'Dose not recorded'}</p>
            </div>
            <Button variant="ghost" className="min-h-9 px-3 py-1.5 text-xs" onClick={() => stop(m)}>Mark stopped</Button>
          </li>
        ))}
      </ul>
      {stopped.length > 0 && (
        <details className="mt-4 text-sm text-slate-500">
          <summary className="cursor-pointer font-medium">History ({stopped.length} stopped)</summary>
          <ul className="mt-2 space-y-1">
            {stopped.map((m) => <li key={m.id}>{m.medicationName}{m.endedOn ? ` · stopped ${formatDay(`${m.endedOn}T00:00:00+05:30`)}` : ''}</li>)}
          </ul>
        </details>
      )}
    </Card>
  );
}
