import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ClipboardPen, ShieldAlert, UserRound } from 'lucide-react';
import { PageLoader } from '../../components/PageLoader';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { useToast } from '../../components/ui/Toast';
import { apiRequest } from '../../lib/api';
import { formatDateTime, formatTime } from '../../lib/format';
import { messageOf, useApi } from '../../lib/useApi';
import type { Appointment } from '../../types/clinical';
import { Hero, InfoRow } from '../dashboards/RoleDashboard';
import { StatusPill } from './StatusPill';

interface DetailResponse {
  appointment: Appointment;
  consultation: { id: string; status: 'DRAFT' | 'FINALIZED' } | null;
}

/** One appointment, the escalation reasons, and the way into the consultation. */
export default function DoctorAppointmentPage() {
  const { appointmentId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const detail = useApi<DetailResponse>(`/api/v1/doctor/appointments/${appointmentId}`);
  const [busy, setBusy] = useState(false);

  if (detail.loading) return <PageLoader label="Loading appointment" />;
  if (detail.error || !detail.data) {
    return (
      <Card className="mx-auto max-w-lg text-center">
        <ShieldAlert className="mx-auto size-10 text-amber-500" aria-hidden="true" />
        <p role="alert" className="mt-3 text-sm font-medium text-ink">{detail.error ?? 'Appointment not found.'}</p>
        <Link to="/doctor/dashboard" className="mt-4 inline-block text-sm font-semibold text-indigo-700 hover:underline">Back to dashboard</Link>
      </Card>
    );
  }

  const { appointment: a, consultation } = detail.data;
  const started = Date.parse(a.slot.startsAt) <= Date.now() + 15 * 60_000;

  async function confirm() {
    setBusy(true);
    try {
      await apiRequest(`/api/v1/doctor/appointments/${a.id}/status`, { method: 'PATCH', body: { status: 'CONFIRMED' } });
      toast.notify('success', 'Appointment confirmed');
      detail.reload();
    } catch (err) {
      toast.notify('error', messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function startConsultation() {
    setBusy(true);
    try {
      const c = await apiRequest<{ id: string }>(`/api/v1/doctor/appointments/${a.id}/consultation`, { method: 'POST' });
      navigate(`/doctor/consultations/${c.id}`);
    } catch (err) {
      toast.notify('error', messageOf(err));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <Link to="/doctor/dashboard" className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-800 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Dashboard
      </Link>
      <Hero role="DOCTOR" title={a.patient.name} subtitle={`${formatDateTime(a.slot.startsAt)} · ${a.chiefComplaint}`} chips={[a.severity.toLowerCase()]} />

      {a.escalated && (
        <div role="alert" className="flex gap-4 rounded-2xl border border-rose-300 bg-gradient-to-r from-rose-50 to-amber-50 p-5 shadow-sm">
          <ShieldAlert className="mt-0.5 size-6 shrink-0 text-rose-600" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-semibold text-rose-900">Escalated for review: possible emergency terms in the booking</p>
            <p className="text-sm text-rose-900/90">
              Matched: {a.escalationReasons.join(', ')}. This flag is set by fixed rules and is not a diagnosis. Review the patient promptly and follow your clinical judgement.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Visit request" actions={<StatusPill status={a.status} />}>
          <dl className="grid gap-x-10 sm:grid-cols-2">
            <div className="sm:divide-y sm:divide-slate-100">
              <InfoRow label="Time" value={`${formatDateTime(a.slot.startsAt)} – ${formatTime(a.slot.endsAt)}`} />
              <InfoRow label="Duration" value={`${a.durationDays} day${a.durationDays === 1 ? '' : 's'}`} />
              <InfoRow label="Severity (patient-reported)" value={a.severity.toLowerCase()} />
            </div>
            <div className="sm:divide-y sm:divide-slate-100">
              <InfoRow label="Concern" value={a.chiefComplaint} />
              <InfoRow label="Additional notes" value={a.additionalNotes ?? ''} />
            </div>
          </dl>
          <div className="mt-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Symptoms reported</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {a.symptoms.length === 0 && <li className="text-sm text-slate-500">None listed</li>}
              {a.symptoms.map((s) => <li key={s} className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700">{s}</li>)}
            </ul>
          </div>
        </Card>

        <Card title="Actions">
          <div className="flex flex-col gap-3">
            {consultation && (
              <Link to={`/doctor/consultations/${consultation.id}`} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-sky-500 px-5 text-sm font-semibold text-white shadow-md">
                <ClipboardPen className="size-4" aria-hidden="true" /> {consultation.status === 'DRAFT' ? 'Continue consultation' : 'View consultation'}
              </Link>
            )}
            {!consultation && a.status === 'CONFIRMED' && (
              <Button onClick={startConsultation} loading={busy} disabled={!started} title={started ? undefined : 'Opens 15 minutes before the slot'}>
                <ClipboardPen className="size-4" aria-hidden="true" /> Start consultation
              </Button>
            )}
            {!consultation && a.status === 'REQUESTED' && (
              <Button variant="secondary" onClick={confirm} loading={busy}>Confirm appointment</Button>
            )}
            <Link to={`/doctor/patients/${a.patient.id}`} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-white px-5 text-sm font-semibold text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-50">
              <UserRound className="size-4" aria-hidden="true" /> Open patient chart
            </Link>
            {!started && !consultation && a.status === 'CONFIRMED' && (
              <p className="text-xs text-slate-500">The consultation opens 15 minutes before the slot.</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
