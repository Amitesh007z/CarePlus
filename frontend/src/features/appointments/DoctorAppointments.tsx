import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, CheckCircle2, UserRound } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { useToast } from '../../components/ui/Toast';
import { apiRequest } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { messageOf, useApi } from '../../lib/useApi';
import type { Appointment, PageMeta } from '../../types/clinical';
import { StatusPill } from './StatusPill';

interface DoctorListResponse {
  items: Appointment[];
  meta: PageMeta;
  window: { from: string; to: string; timezone: string };
}

/** The doctor's own queue for the next 7 days. The server filters to this doctor and to consenting patients. */
export function DoctorAppointments() {
  const toast = useToast();
  const list = useApi<DoctorListResponse>('/api/v1/doctor/appointments?pageSize=50');
  const [busyId, setBusyId] = useState<string | null>(null);

  async function setStatus(a: Appointment, status: 'CONFIRMED' | 'COMPLETED') {
    setBusyId(a.id);
    try {
      await apiRequest(`/api/v1/doctor/appointments/${a.id}/status`, { method: 'PATCH', body: { status } });
      toast.notify('success', status === 'CONFIRMED' ? 'Appointment confirmed' : 'Visit marked complete');
      list.reload();
    } catch (err) {
      toast.notify('error', messageOf(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card
      title="Upcoming patients"
      description={list.data ? `Next 7 days · ${list.data.meta.total} appointment${list.data.meta.total === 1 ? '' : 's'}` : 'Your queue, in booking order.'}
    >
      {list.loading && <p role="status" className="text-sm text-slate-500">Loading your queue…</p>}
      {list.error && (
        <div role="alert" className="flex items-center gap-3 text-sm text-rose-700">{list.error} <Button variant="secondary" onClick={list.reload}>Retry</Button></div>
      )}
      {list.data && list.data.items.length === 0 && (
        <p className="flex items-center gap-2 py-4 text-sm text-slate-500"><CalendarDays className="size-4" aria-hidden="true" /> No appointments in the next 7 days.</p>
      )}
      <ul className="divide-y divide-slate-100">
        {list.data?.items.map((a) => {
          const started = Date.parse(a.slot.startsAt) <= Date.now();
          return (
            <li key={a.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-ink">{a.patient.name}</p>
                  <StatusPill status={a.status} />
                  <span className="text-xs font-medium text-slate-500">{a.severity.toLowerCase()}</span>
                </div>
                <p className="text-sm text-slate-600">{formatDateTime(a.slot.startsAt)} · {a.chiefComplaint}</p>
                {a.symptoms.length > 0 && <p className="text-xs text-slate-500">Symptoms: {a.symptoms.join(', ')}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                {a.status === 'REQUESTED' && (
                  <Button variant="secondary" loading={busyId === a.id} onClick={() => setStatus(a, 'CONFIRMED')}>Confirm</Button>
                )}
                {a.status === 'CONFIRMED' && (
                  <Button variant="secondary" disabled={!started} loading={busyId === a.id} onClick={() => setStatus(a, 'COMPLETED')} title={started ? undefined : 'Available once the slot starts'}>
                    <CheckCircle2 className="size-4" aria-hidden="true" /> Mark complete
                  </Button>
                )}
                <Link to={`/doctor/patients/${a.patient.id}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-indigo-700 hover:bg-indigo-50">
                  <UserRound className="size-4" aria-hidden="true" /> Patient record
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
