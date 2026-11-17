import type { AppointmentStatus } from '../../types/clinical';

const STATUS_STYLE: Record<AppointmentStatus, { label: string; tone: string }> = {
  REQUESTED: { label: 'Requested', tone: 'bg-amber-100 text-amber-900 ring-amber-200' },
  CONFIRMED: { label: 'Confirmed', tone: 'bg-emerald-100 text-emerald-800 ring-emerald-200' },
  COMPLETED: { label: 'Completed', tone: 'bg-sky-100 text-sky-800 ring-sky-200' },
  CANCELLED: { label: 'Cancelled', tone: 'bg-slate-100 text-slate-600 ring-slate-200' },
};

export function StatusPill({ status }: { status: AppointmentStatus }) {
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${STATUS_STYLE[status].tone}`}>
      {STATUS_STYLE[status].label}
    </span>
  );
}
