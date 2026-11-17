import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, HeartPulse, Pill, ShieldAlert } from 'lucide-react';
import { PageLoader } from '../../components/PageLoader';
import { Card } from '../../components/ui/Card';
import { formatDay } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import type { PatientContext } from '../../types/clinical';
import { Hero, InfoRow } from '../dashboards/RoleDashboard';

const severityTone = (s: string | null) =>
  s === 'SEVERE' ? 'bg-rose-100 text-rose-800' : s === 'MODERATE' ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-800';

/** Clinical context for a patient under the doctor's care. Address and contact details are never shown. */
export default function PatientContextPage() {
  const { patientId = '' } = useParams();
  const ctx = useApi<PatientContext>(`/api/v1/doctor/patients/${patientId}/context`);

  if (ctx.loading) return <PageLoader label="Loading patient record" />;
  if (ctx.error || !ctx.data) {
    return (
      <Card className="mx-auto max-w-lg text-center">
        <ShieldAlert className="mx-auto size-10 text-amber-500" aria-hidden="true" />
        <p role="alert" className="mt-3 text-sm font-medium text-ink">{ctx.error ?? 'Record unavailable.'}</p>
        <Link to="/doctor/dashboard" className="mt-4 inline-block text-sm font-semibold text-indigo-700 hover:underline">Back to dashboard</Link>
      </Card>
    );
  }

  const c = ctx.data;
  return (
    <div className="space-y-8">
      <Link to="/doctor/dashboard" className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-800 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Dashboard
      </Link>
      <Hero
        role="DOCTOR"
        title={c.patient.fullName}
        subtitle="Clinical context shared for an active appointment. Use it for care only."
        chips={[`${c.patient.age} years`, c.patient.gender.toLowerCase(), c.patient.bloodGroup !== 'UNKNOWN' ? `Blood ${c.patient.bloodGroup}` : 'Blood group unknown']}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-2"><ShieldAlert className="size-4 text-rose-600" aria-hidden="true" />Allergies</span>} description="Check before prescribing.">
          {c.allergies.length === 0 ? (
            <p className="text-sm text-slate-500">No allergies recorded.</p>
          ) : (
            <ul className="space-y-3">
              {c.allergies.map((a) => (
                <li key={`${a.name}-${a.notedOn}`} className="rounded-xl bg-rose-50/60 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold text-ink">{a.name}</p>
                    {a.severity && <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${severityTone(a.severity)}`}>{a.severity.toLowerCase()}</span>}
                  </div>
                  {a.allergyClass && <p className="text-xs text-slate-500">Class: {a.allergyClass}</p>}
                  {a.notes && <p className="mt-1 text-sm text-slate-600">{a.notes}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={<span className="flex items-center gap-2"><HeartPulse className="size-4 text-amber-600" aria-hidden="true" />Conditions</span>}>
          {c.conditions.length === 0 ? (
            <p className="text-sm text-slate-500">No conditions recorded.</p>
          ) : (
            <ul className="space-y-3">
              {c.conditions.map((x) => (
                <li key={`${x.name}-${x.notedOn}`} className="rounded-xl bg-amber-50/60 p-3">
                  <p className="font-semibold text-ink">{x.name}</p>
                  <p className="text-xs text-slate-500">Noted {formatDay(`${x.notedOn}T00:00:00+05:30`)}{x.severity ? ` · ${x.severity.toLowerCase()}` : ''}</p>
                  {x.notes && <p className="mt-1 text-sm text-slate-600">{x.notes}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="lg:col-span-2" title={<span className="flex items-center gap-2"><Pill className="size-4 text-indigo-600" aria-hidden="true" />Current medications</span>}>
          {c.medications.length === 0 ? (
            <p className="text-sm text-slate-500">No active medications recorded.</p>
          ) : (
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
    </div>
  );
}
