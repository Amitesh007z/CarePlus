import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ShieldAlert } from 'lucide-react';
import { PageLoader } from '../../components/PageLoader';
import { Card } from '../../components/ui/Card';
import { formatDateTime } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import { Hero } from '../dashboards/RoleDashboard';
import type { PrescriptionReview } from './types';

const STATUS_TONE: Record<string, string> = {
  ISSUED: 'bg-emerald-50 text-emerald-900 ring-emerald-200',
  FULFILLED: 'bg-indigo-50 text-indigo-900 ring-indigo-200',
  EXPIRED: 'bg-slate-100 text-slate-700 ring-slate-300',
  SUPERSEDED: 'bg-slate-100 text-slate-700 ring-slate-300',
};

/**
 * Read-only prescription for pharmacy checks. Only the fields in the review contract are rendered, so anything
 * else the server might send (diagnosis, advice, consultation notes) is never shown. Pharmacists cannot edit items.
 */
export function PrescriptionReviewPage() {
  const { prescriptionId = '' } = useParams();
  const rx = useApi<PrescriptionReview>(`/api/v1/pharmacy/prescriptions/${prescriptionId}`);

  if (rx.loading) return <PageLoader label="Opening prescription" />;
  if (rx.error || !rx.data) {
    return (
      <Card className="mx-auto max-w-lg text-center">
        <p role="alert" className="text-sm font-medium text-ink">{rx.error ?? 'Prescription not found.'}</p>
        <Link to="/pharmacy/orders" className="mt-4 inline-block text-sm font-semibold text-teal-700 hover:underline">Back to orders</Link>
      </Card>
    );
  }
  const r = rx.data;
  const hasConflicts = r.checks.allergyConflicts.length > 0 || r.checks.majorInteractions.length > 0;

  return (
    <div className="space-y-8">
      <Link to="/pharmacy/orders" className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-800 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Back to orders
      </Link>
      <Hero role="PHARMACIST" title={`Prescription ${r.rxNumber ?? ''}`.trim()} subtitle={`For ${r.patient.name}, prescribed by ${r.doctor.name}`} chips={[r.status.toLowerCase()]} />

      {r.checks.allergyConflicts.length > 0 && (
        <div role="alert" className="flex gap-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-sm text-rose-900">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-rose-600" aria-hidden="true" />
          <div>
            <p className="font-semibold">Allergy conflict</p>
            <p>Do not dispense: {r.checks.allergyConflicts.join(', ')} conflicts with a recorded allergy. Reject the order instead.</p>
          </div>
        </div>
      )}
      {r.checks.majorInteractions.length > 0 && (
        <div role="alert" className="flex gap-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-sm text-rose-900">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-rose-600" aria-hidden="true" />
          <div>
            <p className="font-semibold">Major drug interaction</p>
            <ul className="list-disc pl-5">
              {r.checks.majorInteractions.map((m, i) => <li key={i}>{m.effect}</li>)}
            </ul>
          </div>
        </div>
      )}
      {!hasConflicts && <p className="rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-900">No allergy conflicts or major interactions were found.</p>}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Medicines" description="Exactly as prescribed. Pharmacists cannot change these lines." className="lg:col-span-2">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="py-2">Medicine</th>
                <th scope="col" className="py-2">Dose</th>
                <th scope="col" className="py-2">Frequency</th>
                <th scope="col" className="py-2">Days</th>
                <th scope="col" className="py-2 text-right">Qty</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {r.items.map((it) => (
                <tr key={it.lineNo}>
                  <td className="py-3">
                    <p className="font-semibold text-ink">{it.name}</p>
                    {it.strength && <p className="text-xs text-slate-500">{it.strength}</p>}
                  </td>
                  <td className="py-3">{it.dose}</td>
                  <td className="py-3">{it.frequency}</td>
                  <td className="py-3">{it.durationDays}</td>
                  <td className="py-3 text-right font-medium">{it.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <aside className="space-y-6">
          <Card title="Validity">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Status</dt><dd><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${STATUS_TONE[r.status] ?? STATUS_TONE.ISSUED}`}>{r.status.toLowerCase()}</span></dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Issued</dt><dd>{r.issuedAt ? formatDateTime(r.issuedAt) : '—'}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Valid till</dt><dd>{r.validTill ?? '—'}</dd></div>
            </dl>
          </Card>
          <Card title="Patient and prescriber">
            <dl className="space-y-2 text-sm">
              <div><dt className="text-slate-500">Patient</dt><dd className="font-medium text-ink">{r.patient.name}, {r.patient.age} years</dd></div>
              <div><dt className="text-slate-500">Prescriber</dt><dd className="font-medium text-ink">{r.doctor.name}</dd></div>
              <div><dt className="text-slate-500">Specialty</dt><dd>{r.doctor.specialty}</dd></div>
              <div><dt className="text-slate-500">Registration</dt><dd>{r.doctor.registrationNo}</dd></div>
            </dl>
          </Card>
        </aside>
      </div>
    </div>
  );
}
