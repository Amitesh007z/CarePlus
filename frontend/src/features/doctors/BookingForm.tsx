import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import { useToast } from '../../components/ui/Toast';
import { ApiError, apiRequest } from '../../lib/api';
import { formatDateTime, formatMoney } from '../../lib/format';
import { messageOf, useApi } from '../../lib/useApi';
import { SEVERITY_OPTIONS, SYMPTOM_SUGGESTIONS, type HealthItem, type Medication, type Slot } from '../../types/clinical';

interface BookingFormProps {
  doctor: { id: string; displayName: string; specialty: string };
  slot: Slot;
  onBooked: () => void;
}

interface Errors {
  chiefComplaint?: string;
  durationDays?: string;
  severity?: string;
}

const textareaClass =
  'block w-full rounded-xl border border-slate-200 bg-white/90 px-3.5 py-2.5 text-sm text-slate-900 shadow-sm focus:border-teal-500 focus:ring-4 focus:ring-teal-500/15 focus:outline-none';

/**
 * Collects the visit details a doctor needs. The patient submits symptoms, never a diagnosis.
 * Saved allergies and medications are shown as context, and are never silently changed.
 */
export function BookingForm({ doctor, slot, onBooked }: BookingFormProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const health = useApi<{ items: HealthItem[] }>('/api/v1/patients/me/health-info?pageSize=100');
  const meds = useApi<{ items: Medication[] }>('/api/v1/patients/me/medications?pageSize=100');

  const [complaint, setComplaint] = useState('');
  const [symptoms, setSymptoms] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [duration, setDuration] = useState('');
  const [severity, setSeverity] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const addSymptom = (value: string) => {
    const v = value.trim();
    if (v.length < 2 || symptoms.includes(v) || symptoms.length >= 15) return;
    setSymptoms([...symptoms, v]);
  };

  const activeAllergies = (health.data?.items ?? []).filter((h) => h.active && h.type === 'ALLERGY');
  const activeConditions = (health.data?.items ?? []).filter((h) => h.active && h.type === 'CONDITION');
  const activeMeds = (meds.data?.items ?? []).filter((m) => m.active);

  function onReview(e: FormEvent) {
    e.preventDefault();
    const next: Errors = {};
    if (complaint.trim().length < 3) next.chiefComplaint = 'Describe your main concern (at least 3 characters)';
    const days = Number(duration);
    if (duration === '' || !Number.isInteger(days) || days < 0 || days > 3650) next.durationDays = 'Enter how many days you have had this';
    if (!severity) next.severity = 'Choose how severe it feels';
    setErrors(next);
    if (Object.keys(next).length === 0) setReviewing(true);
  }

  async function onConfirm() {
    setSubmitting(true);
    setFormError(null);
    try {
      await apiRequest('/api/v1/appointments', {
        method: 'POST',
        body: {
          slotId: slot.id,
          chiefComplaint: complaint.trim(),
          symptoms,
          durationDays: Number(duration),
          severity,
          additionalNotes: notes.trim() || null,
        },
      });
      toast.notify('success', `Booked with ${doctor.displayName} · ${formatDateTime(slot.startsAt)}`);
      navigate('/appointments');
    } catch (err) {
      setReviewing(false);
      if (err instanceof ApiError && err.code === 'SLOT_TAKEN') {
        setFormError('Someone just booked this time. Please pick another slot.');
        onBooked();
      } else {
        setFormError(messageOf(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-gradient-to-br from-teal-50 to-cyan-50 p-4 ring-1 ring-teal-100">
        <p className="text-xs font-semibold uppercase tracking-wide text-teal-800">From your health profile</p>
        <p className="mt-1 text-sm text-slate-600">Shared with the doctor so they have context. Check it is still right.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {activeAllergies.map((a) => (
            <span key={a.id} className="rounded-full bg-rose-100 px-3 py-1 text-xs font-semibold text-rose-800">
              Allergy: {a.name}{a.severity ? ` · ${a.severity.toLowerCase()}` : ''}
            </span>
          ))}
          {activeConditions.map((c) => (
            <span key={c.id} className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">{c.name}</span>
          ))}
          {activeMeds.map((m) => (
            <span key={m.id} className="rounded-full bg-indigo-100 px-3 py-1 text-xs font-semibold text-indigo-800">{m.medicationName}</span>
          ))}
          {health.loading || meds.loading ? <span className="text-xs text-slate-500">Loading your profile…</span> : null}
          {!health.loading && !meds.loading && !activeAllergies.length && !activeConditions.length && !activeMeds.length ? (
            <span className="text-xs text-slate-500">Nothing recorded yet. You can add details under Health &amp; profile.</span>
          ) : null}
        </div>
      </div>

      <form onSubmit={onReview} noValidate className="space-y-5">
        {formError && (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">{formError}</div>
        )}
        <Input
          label="What is your main concern?"
          placeholder="For example: fever since Monday"
          value={complaint}
          onChange={(e) => setComplaint(e.target.value)}
          error={errors.chiefComplaint}
          maxLength={200}
        />

        <div className="space-y-2">
          <p className="text-sm font-medium text-ink">Symptoms</p>
          <div className="flex flex-wrap gap-2">
            {SYMPTOM_SUGGESTIONS.map((s) => {
              const on = symptoms.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={on}
                  onClick={() => (on ? setSymptoms(symptoms.filter((x) => x !== s)) : addSymptom(s))}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                    on ? 'bg-teal-600 text-white shadow-sm' : 'bg-white text-slate-700 ring-1 ring-slate-200 hover:ring-teal-300'
                  }`}
                >
                  {s}
                </button>
              );
            })}
          </div>
          <div className="flex gap-2">
            <input
              aria-label="Add another symptom"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addSymptom(draft);
                  setDraft('');
                }
              }}
              placeholder="Add another symptom"
              className="min-h-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm"
            />
          </div>
          {symptoms.length > 0 && (
            <p className="text-xs text-slate-500">Selected: {symptoms.join(', ')}</p>
          )}
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Input
            label="How many days?"
            type="number"
            min={0}
            max={3650}
            inputMode="numeric"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            error={errors.durationDays}
          />
          <Select label="How severe does it feel?" placeholder="Choose" options={SEVERITY_OPTIONS} value={severity} onChange={(e) => setSeverity(e.target.value)} error={errors.severity} />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="notes" className="block text-sm font-medium text-ink">Anything else? <span className="font-normal text-slate-500">(optional)</span></label>
          <textarea id="notes" rows={3} maxLength={1000} className={textareaClass} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-slate-50 p-4">
          <p className="text-sm text-slate-600">
            Booking fee <strong className="text-ink">{formatMoney(100)}</strong>{' '}
            <span className="text-slate-500">(simulated; no payment is taken)</span>
          </p>
          <Button type="submit">Review booking</Button>
        </div>
      </form>

      <Modal open={reviewing} title="Confirm your appointment" onClose={() => setReviewing(false)}>
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between gap-4"><dt className="text-slate-500">Doctor</dt><dd className="font-medium text-ink">{doctor.displayName}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-slate-500">When</dt><dd className="font-medium text-ink">{formatDateTime(slot.startsAt)}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-slate-500">Concern</dt><dd className="text-right font-medium text-ink">{complaint}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-slate-500">Severity</dt><dd className="font-medium text-ink">{severity.toLowerCase()}</dd></div>
        </dl>
        <p className="mt-4 rounded-xl bg-teal-50 p-3 text-xs text-teal-900">
          Free to cancel or reschedule until 2 hours before the slot. After that, cancelling forfeits the {formatMoney(100)} simulated booking fee.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="secondary" onClick={() => setReviewing(false)} disabled={submitting}>Edit</Button>
          <Button loading={submitting} onClick={onConfirm}>Confirm booking</Button>
        </div>
      </Modal>
    </div>
  );
}
