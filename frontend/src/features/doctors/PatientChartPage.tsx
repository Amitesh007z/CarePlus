import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, FileText, HeartPulse, Pill, ShieldAlert } from 'lucide-react';
import { PageLoader } from '../../components/PageLoader';
import { Card } from '../../components/ui/Card';
import { formatDateTime } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import type { PageMeta, PatientContext, VisitSummary } from '../../types/clinical';
import { Hero, InfoRow } from '../dashboards/RoleDashboard';
import { formatVitals } from '../consultations/vitals';

interface HistoryResponse {
  items: VisitSummary[];
  meta: PageMeta;
}

const severityTone = (s: string | null) =>
  s === 'SEVERE' ? 'bg-rose-100 text-rose-800' : s === 'MODERATE' ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-800';

/** Patient chart for a treating doctor: demographics, health context, and past finalized visits. */
export default function PatientChartPage() {
  const { patientId = '' } = useParams();
  const [tab, setTab] = useState<'overview' | 'visits'>('overview');
  const ctx = useApi<PatientContext>(`/api/v1/doctor/patients/${patientId}/context`);
  const history = useApi<HistoryResponse>(`/api/v1/doctor/patients/${patientId}/history?pageSize=50`);

  if (ctx.loading) return <PageLoader label="Loading patient chart" />;
  if (ctx.error || !ctx.data) {
    return (
      <Card className="mx-auto max-w-lg text-center">
        <ShieldAlert className="mx-auto size-10 text-amber-500" aria-hidden="true" />
        <p role="alert" className="mt-3 text-sm font-medium text-ink">{ctx.error ?? 'Chart unavailable.'}</p>
        <Link to="/doctor/dashboard" className="mt-4 inline-block text-sm font-semibold text-indigo-700 hover:underline">Back to dashboard</Link>
      </Card>
    );
  }

  const c = ctx.data;
  const latest = history.data?.items[0]?.vitals ?? null;

  return (
    <div className="space-y-8">
      <Link to="/doctor/dashboard" className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-800 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Dashboard
      </Link>
      <Hero
        role="DOCTOR"
        title={c.patient.fullName}
        subtitle="Shared for an active appointment with you. Use it for care only."
        chips={[`${c.patient.age} years`, c.patient.gender.toLowerCase(), c.patient.bloodGroup !== 'UNKNOWN' ? `Blood ${c.patient.bloodGroup}` : 'Blood group unknown']}
      />

      <div role="tablist" aria-label="Chart sections" className="inline-flex rounded-2xl bg-white/80 p-1 ring-1 ring-slate-200">
        {(['overview', 'visits'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-xl px-5 py-2 text-sm font-semibold transition ${tab === t ? 'bg-gradient-to-r from-indigo-600 to-sky-500 text-white shadow-md' : 'text-slate-600 hover:text-ink'}`}
          >
            {t === 'overview' ? 'Overview' : 'Visits & diagnoses'}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Demographics" className="lg:col-span-2">
            <dl className="grid gap-x-10 sm:grid-cols-3">
              <div className="sm:divide-y sm:divide-slate-100"><InfoRow label="Age" value={`${c.patient.age} years`} /><InfoRow label="Gender" value={c.patient.gender.toLowerCase()} /></div>
              <div className="sm:divide-y sm:divide-slate-100"><InfoRow label="Blood group" value={c.patient.bloodGroup === 'UNKNOWN' ? 'Not known' : c.patient.bloodGroup} /></div>
              <div className="sm:divide-y sm:divide-slate-100"><InfoRow label="Latest vitals" value={latest ? formatVitals(latest) : 'No vitals recorded'} /></div>
            </dl>
          </Card>

          <Card title={<span className="flex items-center gap-2"><ShieldAlert className="size-4 text-rose-600" aria-hidden="true" />Allergies</span>} description="Check before prescribing.">
            {c.allergies.length === 0 ? <p className="text-sm text-slate-500">No allergies recorded.</p> : (
              <ul className="space-y-3">
                {c.allergies.map((a) => (
                  <li key={`${a.name}-${a.notedOn}`} className="rounded-xl bg-rose-50/60 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold text-ink">{a.name}</p>
                      {a.severity && <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${severityTone(a.severity)}`}>{a.severity.toLowerCase()}</span>}
                    </div>
                    {a.allergyClass && <p className="text-xs text-slate-500">Class: {a.allergyClass}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={<span className="flex items-center gap-2"><HeartPulse className="size-4 text-amber-600" aria-hidden="true" />Chronic conditions</span>}>
            {c.conditions.length === 0 ? <p className="text-sm text-slate-500">No conditions recorded.</p> : (
              <ul className="space-y-3">
                {c.conditions.map((x) => (
                  <li key={`${x.name}-${x.notedOn}`} className="rounded-xl bg-amber-50/60 p-3">
                    <p className="font-semibold text-ink">{x.name}</p>
                    {x.notes && <p className="mt-1 text-sm text-slate-600">{x.notes}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="lg:col-span-2" title={<span className="flex items-center gap-2"><Pill className="size-4 text-indigo-600" aria-hidden="true" />Current medicines</span>}>
            {c.medications.length === 0 ? <p className="text-sm text-slate-500">No active medicines recorded.</p> : (
              <dl className="grid gap-x-8 divide-y divide-slate-100 sm:grid-cols-2 sm:divide-y-0">
                {c.medications.map((m) => (
                  <div key={`${m.medicationName}-${m.startedOn}`} className="sm:divide-y sm:divide-slate-100">
                    <InfoRow label={m.medicationName} value={[m.dose, m.frequency].filter(Boolean).join(' · ')} />
                  </div>
                ))}
              </dl>
            )}
          </Card>
        </div>
      )}

      {tab === 'visits' && (
        <div className="space-y-4">
          {history.loading && <p role="status" className="text-sm text-slate-500">Loading visits…</p>}
          {history.error && <p role="alert" className="text-sm text-rose-700">{history.error}</p>}
          {history.data && history.data.items.length === 0 && <p className="text-sm text-slate-500">No finalized visits yet.</p>}
          {history.data?.items.map((v) => (
            <Card key={v.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-ink">{v.diagnosis.description}</p>
                  <p className="text-sm text-slate-500">{formatDateTime(v.finalizedAt)} · {v.doctor.name}, {v.doctor.specialty}</p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${severityTone(v.severity)}`}>{v.severity.toLowerCase()}</span>
              </div>
              <p className="mt-3 text-sm text-slate-700">Complaint: {v.chiefComplaint}</p>
              {v.vitals && <p className="mt-1 text-xs text-slate-500">{formatVitals(v.vitals)}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-slate-500">
                <span className="inline-flex items-center gap-1"><FileText className="size-3.5" aria-hidden="true" /> Diagnosis recorded as free text (not coded)</span>
                {v.addenda.length > 0 && <span>{v.addenda.length} correction{v.addenda.length > 1 ? 's' : ''}</span>}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
