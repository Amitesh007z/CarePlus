import { useMemo, useState } from 'react';
import { CalendarClock, Stethoscope, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { SlotPicker } from '../doctors/SlotPicker';
import { apiRequest } from '../../lib/api';
import { formatDateTime, formatMoney, hoursUntil } from '../../lib/format';
import { messageOf, useApi } from '../../lib/useApi';
import type { Appointment, PageMeta, Slot } from '../../types/clinical';
import { Hero } from '../dashboards/RoleDashboard';
import { StatusPill } from './StatusPill';

interface ListResponse {
  items: Appointment[];
  meta: PageMeta;
}

type Tab = 'upcoming' | 'past';

export default function AppointmentsPage() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('upcoming');
  const list = useApi<ListResponse>(`/api/v1/appointments/me?scope=${tab}&pageSize=50`);
  const [cancelTarget, setCancelTarget] = useState<Appointment | null>(null);
  const [rescheduleTarget, setRescheduleTarget] = useState<Appointment | null>(null);
  const [newSlot, setNewSlot] = useState<Slot | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const cancelWarning = useMemo(() => {
    if (!cancelTarget) return null;
    return hoursUntil(cancelTarget.slot.startsAt) < 2
      ? `Cancelling inside 2 hours forfeits the ${formatMoney(100)} booking fee (simulated).`
      : `Free cancellation. The ${formatMoney(100)} booking fee is released (simulated).`;
  }, [cancelTarget]);

  async function confirmCancel() {
    if (!cancelTarget) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiRequest(`/api/v1/appointments/${cancelTarget.id}/cancel`, { method: 'POST', body: { reason: reason.trim() || null } });
      toast.notify('success', 'Appointment cancelled');
      setCancelTarget(null);
      setReason('');
      list.reload();
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmReschedule() {
    if (!rescheduleTarget || !newSlot) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiRequest(`/api/v1/appointments/${rescheduleTarget.id}/reschedule`, { method: 'PATCH', body: { slotId: newSlot.id } });
      toast.notify('success', `Rescheduled to ${formatDateTime(newSlot.startsAt)}`);
      setRescheduleTarget(null);
      setNewSlot(null);
      list.reload();
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <Hero role="PATIENT" title="Your appointments" subtitle="Upcoming visits and your visit history. Changes are free up to 2 hours before a slot." />

      <div role="tablist" aria-label="Appointment view" className="inline-flex rounded-2xl bg-white/80 p-1 ring-1 ring-slate-200">
        {(['upcoming', 'past'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-xl px-5 py-2 text-sm font-semibold capitalize transition ${tab === t ? 'bg-gradient-to-r from-teal-600 to-emerald-500 text-white shadow-md' : 'text-slate-600 hover:text-ink'}`}
          >
            {t === 'upcoming' ? 'Upcoming' : 'History'}
          </button>
        ))}
      </div>

      {list.loading && <p role="status" className="text-sm text-slate-500">Loading appointments…</p>}
      {list.error && (
        <div role="alert" className="flex items-center gap-3 rounded-xl bg-rose-50 p-4 text-sm text-rose-800">
          {list.error} <Button variant="secondary" onClick={list.reload}>Try again</Button>
        </div>
      )}
      {list.data && list.data.items.length === 0 && (
        <Card className="text-center">
          <CalendarClock className="mx-auto size-10 text-teal-500" aria-hidden="true" />
          <p className="mt-3 font-semibold text-ink">{tab === 'upcoming' ? 'No upcoming appointments' : 'No past appointments yet'}</p>
          <Link to="/doctors" className="mt-4 inline-block rounded-xl bg-gradient-to-r from-teal-600 to-emerald-500 px-5 py-2.5 text-sm font-semibold text-white shadow-md">
            Find a doctor
          </Link>
        </Card>
      )}

      <ul className="grid gap-5 lg:grid-cols-2">
        {list.data?.items.map((a) => {
          const open = a.status === 'REQUESTED' || a.status === 'CONFIRMED';
          const hours = hoursUntil(a.slot.startsAt);
          const canChange = open && hours > 0;
          return (
            <li key={a.id}>
              <article className="flex h-full flex-col rounded-2xl border border-white/70 bg-white/90 p-6 shadow-sm ring-1 ring-slate-900/5">
                <header className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-sky-500 text-white">
                      <Stethoscope className="size-5" aria-hidden="true" />
                    </span>
                    <div>
                      <p className="font-semibold text-ink">{a.doctor.name}</p>
                      <p className="text-sm text-slate-500">{a.doctor.specialty}</p>
                    </div>
                  </div>
                  <StatusPill status={a.status} />
                </header>

                <p className="mt-4 text-base font-semibold text-ink">{formatDateTime(a.slot.startsAt)}</p>
                <p className="mt-1 text-sm text-slate-600">{a.chiefComplaint}</p>
                {a.symptoms.length > 0 && (
                  <ul className="mt-3 flex flex-wrap gap-1.5">
                    {a.symptoms.map((s) => (
                      <li key={s} className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-700">{s}</li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 text-xs text-slate-500">
                  Booking fee {formatMoney(a.booking.feeInr)} · {a.booking.feeStatus.replace('SIMULATED_', '').toLowerCase()} (simulated)
                </p>

                {canChange && (
                  <footer className="mt-5 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
                    <Button
                      variant="secondary"
                      disabled={hours < 2}
                      title={hours < 2 ? 'Rescheduling closes 2 hours before the slot' : undefined}
                      onClick={() => { setRescheduleTarget(a); setNewSlot(null); setActionError(null); }}
                    >
                      Reschedule
                    </Button>
                    <Button variant="danger" onClick={() => { setCancelTarget(a); setActionError(null); }}>
                      <XCircle className="size-4" aria-hidden="true" /> Cancel
                    </Button>
                  </footer>
                )}
                {a.cancellation && (
                  <p className="mt-4 text-xs text-slate-500">Cancelled {formatDateTime(a.cancellation.at)}{a.cancellation.reason ? ` · “${a.cancellation.reason}”` : ''}</p>
                )}
              </article>
            </li>
          );
        })}
      </ul>

      <Modal open={cancelTarget !== null} title="Cancel this appointment?" onClose={() => setCancelTarget(null)}>
        {cancelTarget && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              {cancelTarget.doctor.name} · {formatDateTime(cancelTarget.slot.startsAt)}
            </p>
            <p className={`rounded-xl p-3 text-sm ${hoursUntil(cancelTarget.slot.startsAt) < 2 ? 'bg-amber-50 text-amber-900' : 'bg-teal-50 text-teal-900'}`}>
              {cancelWarning}
            </p>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-ink">Reason (optional)</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="min-h-10 w-full rounded-xl border border-slate-200 px-3 text-sm" />
            </label>
            {actionError && <p role="alert" className="text-sm text-rose-700">{actionError}</p>}
            <div className="flex justify-end gap-3">
              <Button variant="secondary" onClick={() => setCancelTarget(null)} disabled={busy}>Keep appointment</Button>
              <Button variant="danger" loading={busy} onClick={confirmCancel}>Yes, cancel</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={rescheduleTarget !== null} title="Choose a new time" onClose={() => setRescheduleTarget(null)}>
        {rescheduleTarget && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">Same doctor: {rescheduleTarget.doctor.name}. Your current time is released once you confirm.</p>
            <SlotPicker doctorId={rescheduleTarget.doctor.id} selectedId={newSlot?.id ?? null} onSelect={setNewSlot} />
            {newSlot && <p className="rounded-xl bg-teal-50 p-3 text-sm text-teal-900">New time: {formatDateTime(newSlot.startsAt)}</p>}
            {actionError && <p role="alert" className="text-sm text-rose-700">{actionError}</p>}
            <div className="flex justify-end gap-3">
              <Button variant="secondary" onClick={() => setRescheduleTarget(null)} disabled={busy}>Close</Button>
              <Button loading={busy} disabled={!newSlot} onClick={confirmReschedule}>Confirm new time</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
