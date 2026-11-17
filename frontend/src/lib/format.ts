/** Clinic schedules are in India Standard Time. Every display goes through these helpers. */
const TZ = 'Asia/Kolkata';

const dayFormat = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
const timeFormat = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
const keyFormat = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ });

export const formatDay = (iso: string) => dayFormat.format(new Date(iso));
export const formatTime = (iso: string) => timeFormat.format(new Date(iso));
export const formatDateTime = (iso: string) => `${formatDay(iso)} · ${formatTime(iso)}`;

/** YYYY-MM-DD for an instant, in clinic time. */
export const dayKey = (iso: string | Date) => keyFormat.format(typeof iso === 'string' ? new Date(iso) : iso);
export const todayKey = () => dayKey(new Date());

export function addDaysKey(key: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export const formatMoney = (amount: number) => `₹${amount.toLocaleString('en-IN')}`;

export const hoursUntil = (iso: string, now = Date.now()) => (Date.parse(iso) - now) / 3_600_000;

export const timeRange = (startTime: string, endTime: string) => `${startTime.slice(0, 5)} – ${endTime.slice(0, 5)}`;
