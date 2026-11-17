import type { FormEvent } from 'react';
import { Activity, Save, Stethoscope } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { SEVERITY_OPTIONS } from '../../types/clinical';
import type { DraftValues } from './draft';

interface Props {
  values: DraftValues;
  onChange: (next: DraftValues) => void;
  errors: Partial<Record<keyof DraftValues, string>>;
  disabled: boolean;
  saving: boolean;
  onSave: () => void;
  onFinalize: () => void;
  serverError: string | null;
  savedAt: string | null;
}

const textareaClass =
  'block w-full rounded-xl border border-slate-200 bg-white/90 px-3.5 py-2.5 text-sm text-slate-900 shadow-sm focus:border-teal-500 focus:ring-4 focus:ring-teal-500/15 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500';

/** The consultation form: complaint, vitals, examination, diagnosis and follow-up, with a draft save. */
export function ConsultationForm({ values, onChange, errors, disabled, saving, onSave, onFinalize, serverError, savedAt }: Props) {
  const set = (key: keyof DraftValues) => (e: { target: { value: string } }) => onChange({ ...values, [key]: e.target.value });
  const today = new Date().toISOString().slice(0, 10);

  function submit(e: FormEvent) {
    e.preventDefault();
    onSave();
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-8">
      {serverError && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">{serverError}</p>}

      <section className="space-y-4" aria-labelledby="complaint-heading">
        <h3 id="complaint-heading" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-teal-800">
          <Stethoscope className="size-4" aria-hidden="true" /> Consultation
        </h3>
        <Input label="Chief complaint" value={values.chiefComplaint} onChange={set('chiefComplaint')} error={errors.chiefComplaint} disabled={disabled} maxLength={500} />
        <div className="space-y-1.5">
          <label htmlFor="exam" className="block text-sm font-medium text-ink">Examination notes</label>
          <textarea id="exam" rows={4} maxLength={4000} className={textareaClass} value={values.examinationNotes} onChange={set('examinationNotes')} disabled={disabled} />
        </div>
      </section>

      <section className="space-y-4 rounded-2xl bg-rose-50/50 p-5 ring-1 ring-rose-100" aria-labelledby="vitals-heading">
        <h3 id="vitals-heading" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-rose-800">
          <Activity className="size-4" aria-hidden="true" /> Vitals <span className="font-normal normal-case text-slate-500">(optional, enter what was measured)</span>
        </h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Input label="Systolic (mmHg)" inputMode="numeric" value={values.bpSystolic} onChange={set('bpSystolic')} error={errors.bpSystolic} disabled={disabled} />
          <Input label="Diastolic (mmHg)" inputMode="numeric" value={values.bpDiastolic} onChange={set('bpDiastolic')} error={errors.bpDiastolic} disabled={disabled} />
          <Input label="Pulse (per min)" inputMode="numeric" value={values.pulse} onChange={set('pulse')} error={errors.pulse} disabled={disabled} />
          <Input label="Temperature (°C)" inputMode="decimal" value={values.temperatureC} onChange={set('temperatureC')} error={errors.temperatureC} disabled={disabled} />
          <Input label="SpO₂ (%)" inputMode="numeric" value={values.spo2} onChange={set('spo2')} error={errors.spo2} disabled={disabled} />
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="diagnosis-heading">
        <h3 id="diagnosis-heading" className="text-sm font-semibold uppercase tracking-wide text-indigo-800">Diagnosis and follow-up</h3>
        <div className="rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-900">
          No validated diagnosis code list is loaded in this build. The diagnosis below is recorded as free text and is <strong>not a coded diagnosis</strong>.
        </div>
        <Input label="Diagnosis (free text, not coded)" value={values.diagnosisDescription} onChange={set('diagnosisDescription')} error={errors.diagnosisDescription} disabled={disabled} maxLength={500} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Severity" placeholder="Choose" options={SEVERITY_OPTIONS} value={values.severity} onChange={set('severity')} disabled={disabled} />
          <Input label="Follow-up date (optional)" type="date" min={today} value={values.followUpOn} onChange={set('followUpOn')} disabled={disabled} />
        </div>
      </section>

      {!disabled && (
        <div className="sticky bottom-0 -mx-2 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white/90 p-3 shadow-lg ring-1 ring-slate-200 backdrop-blur">
          <p className="text-xs text-slate-500" role="status">{savedAt ? `Draft saved at ${savedAt}` : 'Not saved yet'}</p>
          <div className="flex gap-2">
            <Button type="submit" variant="secondary" loading={saving}><Save className="size-4" aria-hidden="true" /> Save draft</Button>
            <Button type="button" onClick={onFinalize} disabled={saving}>Finalize consultation</Button>
          </div>
        </div>
      )}
    </form>
  );
}
