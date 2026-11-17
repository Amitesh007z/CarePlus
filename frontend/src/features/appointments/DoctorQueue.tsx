import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, ChevronRight, ShieldAlert } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { useToast } from '../../components/ui/Toast';
import { apiRequest } from '../../lib/api';
import { addDaysKey, formatTime, todayKey } from '../../lib/format';
import { messageOf, useApi } from '../../lib/useApi';
import type { Appointment, PageMeta } from '../../types/clinical';
import { StatusPill } from './StatusPill';

interface QueueResponse {
  items: Appointment[];
  meta: PageMeta;
}

type Tab = 'today' | 'upcoming';

/** Today and upcoming queues. Escalated visits are listed first by the server. */
export function DoctorQueue() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('today');
  const today = todayKey();
  const path =
    tab === 'today'
      ? `/api/v1/doctor/appointments?from=${today}&to=${addDaysKey(today, 1)}&pageSize=50`
      : `/api/v1/doctor/appointments?from=${addDaysKey(today, 1)}&to=${addDaysKey(today, 15)}&pageSize=50`;
  const list = useApi<QueueResponse>(path);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function confirm(a: Appointment) {
    setBusyId(a.id);
    try {
      await apiRequest(`/api/v1/doctor/appointments/${a.id}/status`, { method: 'PATCH', body: { status: 'CONFIRMED' } });
      toast.notify('success', `Confirmed ${a.patient.name}`);
      list.reload();
    } catch (err) {
      toast.notify('error', messageOf(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card
      title={tab === 'today' ? "Today's appointments" : 'Upcoming appointments'}
      description={list.data ? `${list.data.meta.total} ${list.data.meta.total === 1 ? 'appointment' : 'appointments'} · India Standard Time` : 'Your queue.'}
      actions={
        <div role="tablist" aria-label="Queue" className="inline-flex rounded-xl bg-slate-100 p-1">
          {(['today', 'upcoming'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold capitalize ${tab === t ? 'bg-white text-indigo-800 shadow-sm' : 'text-slate-600'}`}>
              {t}
            </button>
          ))}
        </div>
      }
    >
      {list.loading && <p role="status" className="text-sm text-slate-500">Loading your queue…</p>}
      {list.error && <div role="alert" className="flex items-center gap-3 text-sm text-rose-700">{list.error} <Button variant="secondary" onClick={list.reload}>Retry</Button></div>}
      {list.data && list.data.items.length === 0 && (
        <p className="flex items-center gap-2 py-6 text-sm text-slate-500"><CalendarDays className="size-4" aria-hidden="true" /> Nothing scheduled here.</p>
      )}
      <ul className="divide-y divide-slate-100">
        {list.data?.items.map((a) => (
          <li key={a.id} className={`flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between ${a.escalated ? 'rounded-xl bg-rose-50/60 px-3 ring-1 ring-rose-200' : ''}`}>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold tabular-nums text-indigo-800">{formatTime(a.slot.startsAt)}</span>
                <p className="font-semibold text-ink">{a.patient.name}</p>
                <StatusPill status={a.status} />
                {a.escalated && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-rose-600 px-2.5 py-0.5 text-xs font-semibold text-white">
                    <ShieldAlert className="size-3.5" aria-hidden="true" /> Escalated
                  </span>
                )}
              </div>
              <p className="truncate text-sm text-slate-600">{a.chiefComplaint}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {a.status === 'REQUESTED' && (
                <Button variant="secondary" loading={busyId === a.id} onClick={() => confirm(a)}>Confirm</Button>
              )}
              <Link to={`/doctor/appointments/${a.id}`} className="inline-flex min-h-11 items-center gap-1 rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700">
                Open visit <ChevronRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
