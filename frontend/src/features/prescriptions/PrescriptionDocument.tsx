import { Download, ShieldCheck } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { formatDateTime } from '../../lib/format';
import { InfoRow } from '../dashboards/RoleDashboard';
import { RxStatusPill } from './RxStatusPill';
import type { Prescription } from './types';

interface Props {
  rx: Prescription;
  onDownload?: () => void;
  downloading?: boolean;
}

/** The prescription as a document: used for the preview and the issued detail. */
export function PrescriptionDocument({ rx, onDownload, downloading = false }: Props) {
  const issued = rx.status !== 'DRAFT';
  return (
    <section className="overflow-hidden rounded-2xl border border-white/70 bg-white/90 shadow-sm ring-1 ring-slate-900/5">
      <div className="bg-gradient-to-r from-indigo-600 via-violet-500 to-sky-500 p-6 text-white">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/80">CarePulse · prescription</p>
            <p className="mt-1 text-2xl font-bold tracking-tight">{rx.rxNumber ?? 'Not yet numbered'}</p>
            <p className="text-sm text-white/90">Synthetic demo document. Not valid for dispensing.</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <RxStatusPill status={rx.status} />
            {issued && onDownload && (
              <Button variant="inverse" loading={downloading} onClick={onDownload} className="min-h-9 px-3 py-1.5 text-xs">
                <Download className="size-4" aria-hidden="true" /> Download PDF
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-6 p-6 sm:grid-cols-2">
        <dl className="space-y-1">
          <div className="sm:divide-y sm:divide-slate-100">
            <InfoRow label="Patient" value={`${rx.patient.name}, ${rx.patient.age} yrs`} />
            <InfoRow label="Issued" value={rx.issuedAt ? formatDateTime(rx.issuedAt) : 'Not issued'} />
            <InfoRow label="Valid till" value={rx.validTill ?? '30 days from issue'} />
          </div>
        </dl>
        <dl className="space-y-1">
          <div className="sm:divide-y sm:divide-slate-100">
            <InfoRow label="Prescriber" value={rx.doctor.name} />
            <InfoRow label="Specialty" value={rx.doctor.specialty} />
            <InfoRow label="Registration no." value={rx.doctor.registrationNo} />
          </div>
        </dl>
      </div>

      <div className="border-t border-slate-100 px-6 py-5">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Medicines</p>
        {rx.items.length === 0 ? (
          <p className="text-sm text-slate-500">No medicines yet.</p>
        ) : (
          <ol className="space-y-3">
            {rx.items.map((it) => (
              <li key={it.id} className="flex gap-4 rounded-xl bg-slate-50 p-4">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-indigo-600 text-sm font-bold text-white">{it.lineNo}</span>
                <div className="min-w-0 space-y-1">
                  <p className="font-semibold text-ink">{it.medicine.name}</p>
                  <p className="text-sm text-slate-600">{it.dose} · {it.frequency} · {it.durationDays} day{it.durationDays === 1 ? '' : 's'} · quantity {it.quantity}</p>
                  {it.instructions && <p className="text-xs text-slate-500">{it.instructions}</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
        {rx.advice && (
          <div className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-semibold">Advice</p>
            <p className="mt-1">{rx.advice}</p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-slate-100 bg-emerald-50/50 px-6 py-4 text-sm text-emerald-900">
        <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
        {issued && rx.allergyCheck
          ? rx.allergyCheck.matches.length === 0
            ? 'Allergy check at issue: no conflicts with recorded allergies.'
            : 'Allergy check at issue: conflicts were recorded.'
          : 'Allergy check runs before issue. It blocks any medicine that matches a recorded allergy.'}
      </div>
    </section>
  );
}
