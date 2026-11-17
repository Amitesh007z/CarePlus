/**
 * Clinic schedules are expressed in India Standard Time (UTC+05:30, no daylight saving).
 * Stored instants are timestamptz (UTC); only availability rules use wall-clock IST values.
 */
export const CLINIC_TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 330 * 60_000;
const IST_SUFFIX = '+05:30';

export interface SlotRule {
  weekday: number; // 0 = Sunday
  startTime: string; // HH:MM[:SS]
  endTime: string;
  slotMinutes: number;
}

export function istDateOf(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The UTC instant for an IST wall-clock date and time. */
export function istInstant(date: string, hhmm: string): Date {
  return new Date(`${date}T${hhmm}:00${IST_SUFFIX}`);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

const toMinutes = (hhmm: string): number => {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};
const toHHMM = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Expands weekly rules into concrete slots for one IST calendar date. */
export function slotsForDate(date: string, rules: SlotRule[]): { startsAt: Date; endsAt: Date }[] {
  const wd = weekdayOf(date);
  const out: { startsAt: Date; endsAt: Date }[] = [];
  for (const rule of rules) {
    if (rule.weekday !== wd) continue;
    const end = toMinutes(rule.endTime);
    for (let m = toMinutes(rule.startTime); m + rule.slotMinutes <= end; m += rule.slotMinutes) {
      const startsAt = istInstant(date, toHHMM(m));
      out.push({ startsAt, endsAt: new Date(startsAt.getTime() + rule.slotMinutes * 60_000) });
    }
  }
  return out;
}
