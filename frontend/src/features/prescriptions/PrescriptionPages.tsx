import { lazy, Suspense, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, ClipboardList, Copy, ShieldAlert } from 'lucide-react';
import { PageLoader } from '../../components/PageLoader';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { ApiError, apiRequest } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { messageOf, useApi } from '../../lib/useApi';
import { usePdfDownload } from './usePdfDownload';
import { Hero } from '../dashboards/RoleDashboard';
import { PrescriptionDocument } from './PrescriptionDocument';
import { PrescriptionEditor } from './PrescriptionEditor';
import { SendToPharmacy, type PatientFulfilment } from './SendToPharmacy';
import { RxStatusPill } from './RxStatusPill';
import { RX_STATUS_STYLE } from './types';
import type { Prescription, PrescriptionSummary } from './types';

// Loaded on demand: only the patient's issued-prescription page needs the cart action.
const BuyFromPrescription = lazy(() => import('../commerce/BuyFromPrescription').then((m) => ({ default: m.BuyFromPrescription })));

/** Doctor: a draft opens the editor; an issued or later record opens the read-only document. */
export function DoctorPrescriptionPage() {
  const { prescriptionId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const loaded = useApi<Prescription>(`/api/v1/doctor/prescriptions/${prescriptionId}`);
  const [current, setCurrent] = useState<Prescription | null>(null);
  const pdf = usePdfDownload();
  const [replacing, setReplacing] = useState(false);

  if (loaded.loading) return <PageLoader label="Opening prescription" />;
  if (loaded.error || !loaded.data) {
    return <ErrorCard message={loaded.error ?? 'Prescription not found.'} back="/doctor/dashboard" />;
  }
  const rx = current && current.id === loaded.data.id ? current : loaded.data;

  async function replace() {
    setReplacing(true);
    try {
      const draft = await apiRequest<Prescription>(`/api/v1/doctor/prescriptions/${rx.id}/replace`, { method: 'POST' });
      toast.notify('success', 'Correction draft created. The original stays active until the replacement is issued.');
      navigate(`/doctor/prescriptions/${draft.id}`);
    } catch (err) {
      toast.notify('error', err instanceof ApiError ? err.message : messageOf(err));
    } finally {
      setReplacing(false);
    }
  }

  return (
    <div className="space-y-8">
      <Link to={`/doctor/consultations/${rx.consultationId}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-800 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Consultation
      </Link>
      <Hero role="DOCTOR" title={rx.status === 'DRAFT' ? 'Prescription draft' : `Prescription ${rx.rxNumber ?? ''}`} subtitle={`For ${rx.patient.name}`} chips={[RX_STATUS_STYLE[rx.status].label]} />

      {rx.status === 'DRAFT' ? (
        <PrescriptionEditor rx={rx} onChanged={setCurrent} />
      ) : (
        <div className="space-y-6">
          <PrescriptionDocument rx={rx} onDownload={() => pdf.download(`/api/v1/doctor/prescriptions/${rx.id}/pdf`, rx.rxNumber)} downloading={pdf.busy} />
          {rx.status === 'ISSUED' && (
            <Card title="Corrections" description="An issued prescription cannot be edited. A correction is a replacement that supersedes this one when issued.">
              <Button variant="secondary" loading={replacing} onClick={replace}><Copy className="size-4" aria-hidden="true" /> Create replacement draft</Button>
            </Card>
          )}
          {rx.supersededById && (
            <p className="text-sm text-amber-900">This prescription was replaced. <Link className="font-semibold underline" to={`/doctor/prescriptions/${rx.supersededById}`}>View the replacement</Link>.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Doctor: the final check before issuing. Shows what will be issued and blocks on any safety conflict. */
export function PrescriptionPreviewPage() {
  const { prescriptionId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const loaded = useApi<Prescription>(`/api/v1/doctor/prescriptions/${prescriptionId}`);
  const [confirming, setConfirming] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<ApiError | null>(null);

  if (loaded.loading) return <PageLoader label="Preparing preview" />;
  if (loaded.error || !loaded.data) return <ErrorCard message={loaded.error ?? 'Prescription not found.'} back="/doctor/dashboard" />;
  const rx = loaded.data;

  if (rx.status !== 'DRAFT') {
    return <ErrorCard message="This prescription has already been issued." back={`/doctor/prescriptions/${rx.id}`} />;
  }

  const canIssue = rx.checks?.canIssue ?? false;

  async function issue() {
    setIssuing(true);
    setIssueError(null);
    try {
      const issued = await apiRequest<Prescription>(`/api/v1/doctor/prescriptions/${rx.id}/issue`, { method: 'POST' });
      setConfirming(false);
      toast.notify('success', `Issued ${issued.rxNumber}. The patient can now see it.`);
      navigate(`/doctor/prescriptions/${issued.id}`);
    } catch (err) {
      setConfirming(false);
      setIssueError(err instanceof ApiError ? err : null);
      if (!(err instanceof ApiError)) toast.notify('error', messageOf(err));
    } finally {
      setIssuing(false);
    }
  }

  return (
    <div className="space-y-8">
      <Link to={`/doctor/prescriptions/${rx.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-800 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Back to editing
      </Link>
      <Hero role="DOCTOR" title="Preview before issuing" subtitle="Check the medicines, quantities and the allergy check. Issuing locks the prescription." />

      {!canIssue && rx.checks && (
        <div role="alert" className="flex gap-4 rounded-2xl border border-rose-300 bg-rose-50 p-5">
          <ShieldAlert className="mt-0.5 size-6 shrink-0 text-rose-600" aria-hidden="true" />
          <div className="space-y-1 text-sm text-rose-900">
            <p className="font-semibold">This prescription cannot be issued yet</p>
            <ul className="list-disc pl-5">{rx.checks.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          </div>
        </div>
      )}
      {issueError && (
        <div role="alert" className="rounded-2xl border border-rose-300 bg-rose-50 p-5 text-sm text-rose-900">
          <p className="font-semibold">{issueError.message}</p>
          {issueError.details.map((d) => <p key={d.path ?? d.message}>{d.message}</p>)}
        </div>
      )}

      <PrescriptionDocument rx={rx} />

      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="secondary" onClick={() => navigate(`/doctor/prescriptions/${rx.id}`)}>Keep editing</Button>
        <Button onClick={() => setConfirming(true)} disabled={!canIssue || issuing}>
          <CheckCircle2 className="size-4" aria-hidden="true" /> Issue prescription
        </Button>
      </div>

      <Modal open={confirming} title="Issue this prescription?" onClose={() => setConfirming(false)}>
        <div className="space-y-4 text-sm">
          <p className="rounded-xl bg-amber-50 p-3 text-amber-900">
            Once issued, the prescription cannot be edited. It is valid for {rx.validityDays} days from issue. Corrections need a replacement.
          </p>
          <p className="text-slate-700">{rx.patient.name} · {rx.items.length} medicine{rx.items.length === 1 ? '' : 's'}</p>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={issuing}>Cancel</Button>
            <Button loading={issuing} onClick={issue}>Yes, issue</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** Patient: every issued prescription, newest first. Drafts are never listed by the server. */
export function PatientPrescriptionsPage() {
  const list = useApi<{ items: PrescriptionSummary[] }>('/api/v1/patients/me/prescriptions?pageSize=50');
  return (
    <div className="space-y-8">
      <Hero role="PATIENT" title="My prescriptions" subtitle="Issued prescriptions from your doctors, with validity and PDF downloads." />
      {list.loading && <PageLoader label="Loading prescriptions" />}
      {list.error && <p role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-800">{list.error}</p>}
      {list.data && list.data.items.length === 0 && (
        <Card className="text-center"><ClipboardList className="mx-auto size-10 text-indigo-500" aria-hidden="true" /><p className="mt-3 font-semibold text-ink">No prescriptions yet</p><p className="mt-1 text-sm text-slate-500">Your doctor will issue one after a consultation.</p></Card>
      )}
      <ul className="grid gap-5 md:grid-cols-2">
        {list.data?.items.map((p) => (
          <li key={p.id}>
            <Link to={`/patient/prescriptions/${p.id}`} className="block rounded-2xl border border-white/70 bg-white/90 p-6 shadow-sm ring-1 ring-slate-900/5 transition hover:-translate-y-0.5 hover:shadow-lg">
              <div className="flex items-start justify-between gap-3">
                <p className="font-semibold text-ink">{p.rxNumber ?? 'Unnumbered'}</p>
                <RxStatusPill status={p.status} />
              </div>
              <p className="mt-1 text-sm text-slate-500">{p.doctor.name}, {p.doctor.specialty}</p>
              <p className="mt-4 text-sm text-slate-700">{p.itemCount} medicine{p.itemCount === 1 ? '' : 's'}{p.issuedAt ? ` · issued ${formatDateTime(p.issuedAt)}` : ''}</p>
              {p.validTill && <p className="mt-1 text-xs text-slate-500">Valid till {p.validTill}</p>}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Patient: one prescription with its medicines, validity and PDF. */
export function PatientPrescriptionDetailPage() {
  const { prescriptionId = '' } = useParams();
  const loaded = useApi<Prescription>(`/api/v1/patients/me/prescriptions/${prescriptionId}`);
  const pharmacy = useApi<{ fulfilment: PatientFulfilment | null }>(`/api/v1/patients/me/prescriptions/${prescriptionId}/fulfilment`);
  const pdf = usePdfDownload();
  if (loaded.loading) return <PageLoader label="Opening prescription" />;
  if (loaded.error || !loaded.data) return <ErrorCard message={loaded.error ?? 'Prescription not found.'} back="/patient/prescriptions" />;
  const rx = loaded.data;
  return (
    <div className="space-y-8">
      <Link to="/patient/prescriptions" className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-800 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> All prescriptions
      </Link>
      <Hero role="PATIENT" title={`Prescription ${rx.rxNumber ?? ''}`} subtitle={`From ${rx.doctor.name}, ${rx.doctor.specialty}`} chips={[RX_STATUS_STYLE[rx.status].label]} />
      {rx.status === 'EXPIRED' && <p role="status" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-800">This prescription has expired. Ask your doctor for a new one.</p>}
      {rx.status === 'FULFILLED' && <p role="status" className="rounded-xl bg-sky-50 p-4 text-sm text-sky-900">This prescription has already been fulfilled and cannot be used again.</p>}
      {rx.status === 'SUPERSEDED' && <p role="status" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">Your doctor issued a correction. Use the newer prescription.</p>}
      <PrescriptionDocument rx={rx} onDownload={() => pdf.download(`/api/v1/patients/me/prescriptions/${rx.id}/pdf`, rx.rxNumber)} downloading={pdf.busy} />
      <Suspense fallback={null}>
        <BuyFromPrescription rxId={rx.id} status={rx.status} pharmacyOpen={(pharmacy.data?.fulfilment?.status ?? 'REJECTED') !== 'REJECTED'} />
      </Suspense>
      <SendToPharmacy rxId={rx.id} status={rx.status} fulfilment={pharmacy.data?.fulfilment ?? null} onChanged={pharmacy.reload} />
    </div>
  );
}

function ErrorCard({ message, back }: { message: string; back: string }) {
  return (
    <Card className="mx-auto max-w-lg text-center">
      <ShieldAlert className="mx-auto size-10 text-amber-500" aria-hidden="true" />
      <p role="alert" className="mt-3 text-sm font-medium text-ink">{message}</p>
      <Link to={back} className="mt-4 inline-block text-sm font-semibold text-indigo-700 hover:underline">Go back</Link>
    </Card>
  );
}
