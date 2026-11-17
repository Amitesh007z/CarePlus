import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Lock, ShieldAlert } from 'lucide-react';
import { PageLoader } from '../../components/PageLoader';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { apiRequest, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { messageOf, useApi } from '../../lib/useApi';
import { SEVERITY_OPTIONS, type ConsultationDetail, type PatientContext } from '../../types/clinical';
import { Hero, InfoRow } from '../dashboards/RoleDashboard';
import { ConsultationForm } from './ConsultationForm';
import { ConsultationPrescriptions } from '../prescriptions/ConsultationPrescriptions';
import { toBody, validate, valuesFrom, type DraftValues } from './draft';

export default function ConsultationPage() {
  const { consultationId = '' } = useParams();
  const detail = useApi<ConsultationDetail>(`/api/v1/doctor/consultations/${consultationId}`);

  if (detail.loading) return <PageLoader label="Opening consultation" />;
  if (detail.error || !detail.data) {
    return (
      <Card className="mx-auto max-w-lg text-center">
        <ShieldAlert className="mx-auto size-10 text-amber-500" aria-hidden="true" />
        <p role="alert" className="mt-3 text-sm font-medium text-ink">{detail.error ?? 'Consultation not found.'}</p>
        <Link to="/doctor/dashboard" className="mt-4 inline-block text-sm font-semibold text-indigo-700 hover:underline">Back to dashboard</Link>
      </Card>
    );
  }
  // Keyed by id so a fresh server copy always resets the local workspace state.
  return <Workspace key={detail.data.id} initial={detail.data} />;
}

function Workspace({ initial }: { initial: ConsultationDetail }) {
  const toast = useToast();
  const [record, setRecord] = useState(initial);
  const [values, setValues] = useState<DraftValues>(() => valuesFrom(initial));
  const [errors, setErrors] = useState<ReturnType<typeof validate>>({});
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [addendum, setAddendum] = useState('');
  const [addendumError, setAddendumError] = useState<string | null>(null);

  const isDraft = record.status === 'DRAFT';
  const context = useApi<PatientContext>(`/api/v1/doctor/patients/${record.patient.id}/context`);

  async function save(): Promise<boolean> {
    const v = validate(values);
    setErrors(v);
    if (Object.keys(v).length) return false;
    setSaving(true);
    setServerError(null);
    try {
      const updated = await apiRequest<ConsultationDetail>(`/api/v1/doctor/consultations/${record.id}`, { method: 'PUT', body: toBody(values) });
      setRecord(updated);
      setValues(valuesFrom(updated));
      setSavedAt(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
      toast.notify('success', 'Draft saved');
      return true;
    } catch (err) {
      setServerError(messageOf(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function finalize() {
    setSaving(true);
    setServerError(null);
    try {
      // Save first so the finalized record contains exactly what is on screen.
      await apiRequest<ConsultationDetail>(`/api/v1/doctor/consultations/${record.id}`, { method: 'PUT', body: toBody(values) });
      const final = await apiRequest<ConsultationDetail>(`/api/v1/doctor/consultations/${record.id}/finalize`, { method: 'POST' });
      setRecord(final);
      setFinalizeOpen(false);
      toast.notify('success', 'Consultation finalized and locked');
    } catch (err) {
      setFinalizeOpen(false);
      if (err instanceof ApiError && err.details.length) {
        setServerError(`${err.message}: ${err.details.map((d) => d.path ?? d.message).join(', ')}`);
      } else {
        setServerError(messageOf(err));
      }
    } finally {
      setSaving(false);
    }
  }

  async function addAddendum() {
    if (addendum.trim().length < 3) return setAddendumError('Write the correction (at least 3 characters)');
    setSaving(true);
    setAddendumError(null);
    try {
      const updated = await apiRequest<ConsultationDetail>(`/api/v1/doctor/consultations/${record.id}/addenda`, { method: 'POST', body: { content: addendum.trim() } });
      setRecord(updated);
      setAddendum('');
      toast.notify('success', 'Correction added. The original record is unchanged.');
    } catch (err) {
      setAddendumError(messageOf(err));
    } finally {
      setSaving(false);
    }
  }

  const missing = [
    !values.chiefComplaint.trim() && 'chief complaint',
    !values.diagnosisDescription.trim() && 'diagnosis',
    !values.severity && 'severity',
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-8">
      <Link to={`/doctor/appointments/${record.appointmentId}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-800 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Appointment
      </Link>
      <Hero
        role="DOCTOR"
        title={record.patient.name}
        subtitle={`${formatDateTime(record.slotStartsAt)} · ${isDraft ? 'Draft: not yet final' : `Finalized ${formatDateTime(record.finalizedAt ?? record.slotStartsAt)}`}`}
        chips={[isDraft ? 'Draft' : 'Finalized and locked']}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title={isDraft ? 'Record the consultation' : 'Consultation record'} description={isDraft ? 'Save as often as you like. Finalizing locks the record.' : 'Finalized records cannot be edited. Corrections are added below.'}>
            {isDraft ? (
              <ConsultationForm
                values={values}
                onChange={setValues}
                errors={errors}
                disabled={false}
                saving={saving}
                onSave={save}
                onFinalize={() => (missing.length ? setServerError(`Before finalizing, complete: ${missing.join(', ')}`) : setFinalizeOpen(true))}
                serverError={serverError}
                savedAt={savedAt}
              />
            ) : (
              <FinalizedSummary record={record} />
            )}
          </Card>

          {!isDraft && (
            <Card title="Corrections" description="Addenda are added after the original and never replace it.">
              {record.addenda.length === 0 && <p className="text-sm text-slate-500">No corrections added.</p>}
              <ul className="space-y-3">
                {record.addenda.map((a) => (
                  <li key={a.id} className="rounded-xl bg-indigo-50/60 p-4 text-sm">
                    <p className="text-xs font-semibold text-indigo-800">{formatDateTime(a.createdAt)}</p>
                    <p className="mt-1 text-slate-700">{a.content}</p>
                  </li>
                ))}
              </ul>
              <div className="mt-5 space-y-3">
                <label htmlFor="addendum" className="block text-sm font-medium text-ink">Add a correction</label>
                <textarea id="addendum" rows={3} maxLength={2000} value={addendum} onChange={(e) => setAddendum(e.target.value)} className="block w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm" />
                {addendumError && <p role="alert" className="text-sm text-rose-700">{addendumError}</p>}
                <div className="flex justify-end">
                  <Button variant="secondary" loading={saving} onClick={addAddendum}>Add correction</Button>
                </div>
              </div>
            </Card>
          )}
        </div>

        <aside className="space-y-6">
          <ConsultationPrescriptions consultationId={record.id} finalized={!isDraft} />
          <Card title="Patient snapshot" description="For safety while you write. Full chart is one click away.">
            {context.loading && <p className="text-sm text-slate-500">Loading…</p>}
            {context.error && <p className="text-sm text-rose-700">{context.error}</p>}
            {context.data && (
              <div className="space-y-4 text-sm">
                <div>
                  <p className="font-semibold text-ink">Allergies</p>
                  {context.data.allergies.length === 0 ? <p className="text-slate-500">None recorded</p> : (
                    <ul className="mt-1 flex flex-wrap gap-1.5">
                      {context.data.allergies.map((a) => (
                        <li key={a.name} className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${a.severity === 'SEVERE' ? 'bg-rose-600 text-white' : 'bg-rose-100 text-rose-800'}`}>
                          {a.name}{a.severity ? ` · ${a.severity.toLowerCase()}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <p className="font-semibold text-ink">Conditions</p>
                  <p className="text-slate-600">{context.data.conditions.map((c) => c.name).join(', ') || 'None recorded'}</p>
                </div>
                <div>
                  <p className="font-semibold text-ink">Medicines</p>
                  <p className="text-slate-600">{context.data.medications.map((m) => m.medicationName).join(', ') || 'None recorded'}</p>
                </div>
              </div>
            )}
            <Link to={`/doctor/patients/${record.patient.id}`} className="mt-5 inline-block text-sm font-semibold text-indigo-700 hover:underline">Open full chart →</Link>
          </Card>
        </aside>
      </div>

      <Modal open={finalizeOpen} title="Finalize this consultation?" onClose={() => setFinalizeOpen(false)}>
        <div className="space-y-4 text-sm">
          <p className="rounded-xl bg-amber-50 p-3 text-amber-900">
            <Lock className="mr-1 inline size-4" aria-hidden="true" />
            Once finalized, this record cannot be edited. Corrections can only be added as addenda.
          </p>
          <dl className="space-y-2">
            <InfoRow label="Patient" value={record.patient.name} />
            <InfoRow label="Diagnosis (not coded)" value={values.diagnosisDescription} />
            <InfoRow label="Severity" value={SEVERITY_OPTIONS.find((s) => s.value === values.severity)?.label ?? ''} />
          </dl>
          {serverError && <p role="alert" className="text-rose-700">{serverError}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setFinalizeOpen(false)} disabled={saving}>Keep editing</Button>
            <Button loading={saving} onClick={finalize}>Finalize and lock</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function FinalizedSummary({ record }: { record: ConsultationDetail }) {
  const v = record.vitals;
  return (
    <dl className="grid gap-x-10 sm:grid-cols-2">
      <div className="sm:divide-y sm:divide-slate-100">
        <InfoRow label="Chief complaint" value={record.chiefComplaint ?? ''} />
        <InfoRow label="Diagnosis (not coded)" value={record.diagnosis.description ?? ''} />
        <InfoRow label="Severity" value={record.severity?.toLowerCase() ?? ''} />
        <InfoRow label="Follow-up" value={record.followUpOn ?? ''} />
      </div>
      <div className="sm:divide-y sm:divide-slate-100">
        <InfoRow label="BP" value={v?.bpSystolic ? `${v.bpSystolic}/${v.bpDiastolic} mmHg` : ''} />
        <InfoRow label="Pulse" value={v?.pulse ? `${v.pulse}/min` : ''} />
        <InfoRow label="Temperature" value={v?.temperatureC ? `${v.temperatureC} °C` : ''} />
        <InfoRow label="SpO₂" value={v?.spo2 ? `${v.spo2}%` : ''} />
      </div>
      <div className="sm:col-span-2 mt-4 rounded-xl bg-slate-50 p-4 text-sm text-slate-700">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Examination notes</p>
        <p className="mt-1 whitespace-pre-line">{record.examinationNotes || 'None recorded'}</p>
      </div>
    </dl>
  );
}
