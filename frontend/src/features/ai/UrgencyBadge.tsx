import type { CareUrgency } from './types';

const STYLE: Record<CareUrgency, { label: string; cls: string }> = {
  SELF_CARE: { label: 'Self-care suggested', cls: 'bg-emerald-100 text-emerald-800 ring-emerald-200' },
  SEE_DOCTOR: { label: 'See a doctor', cls: 'bg-amber-100 text-amber-900 ring-amber-200' },
  EMERGENCY: { label: 'Emergency', cls: 'bg-rose-600 text-white ring-rose-700' },
};

export function UrgencyBadge({ urgency }: { urgency: CareUrgency }) {
  const s = STYLE[urgency];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1 ${s.cls}`} data-testid="urgency">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      Urgency: {s.label}
    </span>
  );
}
