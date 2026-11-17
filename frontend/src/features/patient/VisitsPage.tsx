import { FileText } from 'lucide-react';
import { PageLoader } from '../../components/PageLoader';
import { Card } from '../../components/ui/Card';
import { formatDateTime } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import type { PageMeta, VisitSummary } from '../../types/clinical';
import { Hero } from '../dashboards/RoleDashboard';
import { formatVitals } from '../consultations/vitals';

interface VisitsResponse {
  items: VisitSummary[];
  meta: PageMeta;
}

const severityTone = (s: string) =>
  s === 'SEVERE' ? 'bg-rose-100 text-rose-800' : s === 'MODERATE' ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-800';

/** Your finalized visits, with the diagnosis, vitals and any corrections. Drafts are never shown. */
export default function VisitsPage() {
  const visits = useApi<VisitsResponse>('/api/v1/patients/me/visits?pageSize=50');

  return (
    <div className="space-y-8">
      <Hero role="PATIENT" title="My visits" subtitle="Finished consultations, diagnoses and corrections from your doctors." />
      {visits.loading && <PageLoader label="Loading visits" />}
      {visits.error && <p role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-800">{visits.error}</p>}
      {visits.data && visits.data.items.length === 0 && (
        <Card className="text-center"><p className="font-semibold text-ink">No finished visits yet</p><p className="mt-1 text-sm text-slate-500">They appear here once your doctor completes a consultation.</p></Card>
      )}
      <ul className="space-y-5">
        {visits.data?.items.map((v) => (
          <li key={v.id}>
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-lg font-semibold text-ink">{v.diagnosis.description}</p>
                  <p className="text-sm text-slate-500">{formatDateTime(v.finalizedAt)} · {v.doctor.name}, {v.doctor.specialty}</p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${severityTone(v.severity)}`}>{v.severity.toLowerCase()}</span>
              </div>
              <p className="mt-3 text-sm text-slate-700">Reason for visit: {v.chiefComplaint}</p>
              {v.vitals && <p className="mt-1 text-xs text-slate-500">{formatVitals(v.vitals)}</p>}
              {v.followUpOn && <p className="mt-2 text-sm font-medium text-indigo-800">Follow-up: {v.followUpOn}</p>}
              <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500"><FileText className="size-3.5" aria-hidden="true" /> Diagnosis recorded as free text, not a coded diagnosis.</p>
              {v.addenda.length > 0 && (
                <div className="mt-4 space-y-2 rounded-xl bg-indigo-50/60 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-indigo-800">Corrections added by your doctor</p>
                  {v.addenda.map((a) => (
                    <p key={a.id} className="text-sm text-slate-700"><span className="text-xs text-slate-500">{formatDateTime(a.createdAt)} · </span>{a.content}</p>
                  ))}
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
