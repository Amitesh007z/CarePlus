import { useMemo, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { addDaysKey, dayKey, formatDay, formatTime, todayKey } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import type { Slot, SlotsResponse } from '../../types/clinical';

interface SlotPickerProps {
  doctorId: string;
  selectedId: string | null;
  onSelect: (slot: Slot) => void;
  days?: number;
}

/** A 14-day calendar strip with a slot grid for the chosen day. Booked slots are shown but disabled. */
export function SlotPicker({ doctorId, selectedId, onSelect, days = 14 }: SlotPickerProps) {
  const from = useMemo(() => todayKey(), []);
  const { data, error, loading, reload } = useApi<SlotsResponse>(
    `/api/v1/doctors/${doctorId}/slots?from=${from}&days=${days}`,
  );
  const [chosenDay, setChosenDay] = useState<string | null>(null);

  const dayKeys = useMemo(() => Array.from({ length: days }, (_, i) => addDaysKey(from, i)), [from, days]);
  const byDay = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const s of data?.slots ?? []) {
      const key = dayKey(s.startsAt);
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return map;
  }, [data]);
  const freeCount = (key: string) => (byDay.get(key) ?? []).filter((s) => !s.booked).length;
  const firstFreeDay = dayKeys.find((k) => freeCount(k) > 0) ?? null;
  const activeDay = chosenDay ?? firstFreeDay;

  if (loading) return <p role="status" className="py-6 text-center text-sm text-slate-500">Loading available times…</p>;
  if (error) {
    return (
      <div role="alert" className="space-y-3 rounded-xl bg-rose-50 p-4 text-sm text-rose-800">
        <p>{error}</p>
        <Button variant="secondary" onClick={reload}>Try again</Button>
      </div>
    );
  }
  if (!firstFreeDay) {
    return (
      <div className="rounded-xl bg-amber-50 p-6 text-center text-sm text-amber-900">
        No open slots in the next {days} days. Please check back later.
      </div>
    );
  }

  const slotsForDay = (activeDay && byDay.get(activeDay)) || [];
  return (
    <div className="space-y-5">
      <div role="radiogroup" aria-label="Choose a day" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {dayKeys.map((key) => {
          const free = freeCount(key);
          const sample = byDay.get(key)?.[0];
          const active = key === activeDay;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={`${sample ? formatDay(sample.startsAt) : key}, ${free} open`}
              disabled={free === 0}
              onClick={() => setChosenDay(key)}
              className={`flex min-w-[4.5rem] shrink-0 flex-col items-center rounded-2xl px-3 py-2.5 text-center transition ${
                active
                  ? 'bg-gradient-to-b from-teal-500 to-emerald-500 text-white shadow-lg shadow-teal-600/25'
                  : free > 0
                    ? 'bg-white text-ink ring-1 ring-slate-200 hover:ring-teal-300'
                    : 'bg-slate-100 text-slate-400'
              }`}
            >
              <span className="text-xs font-medium opacity-80">{sample ? formatDay(sample.startsAt).split(',')[0] : ''}</span>
              <span className="text-lg font-bold">{key.slice(8)}</span>
              <span className="text-[11px] opacity-80">{free > 0 ? `${free} open` : 'Full'}</span>
            </button>
          );
        })}
      </div>

      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
        {slotsForDay.map((slot) => {
          const selected = slot.id === selectedId;
          return (
            <li key={slot.id}>
              <button
                type="button"
                disabled={slot.booked}
                aria-pressed={selected}
                aria-label={`${formatTime(slot.startsAt)}, ${slot.booked ? 'booked' : 'available'}`}
                onClick={() => onSelect(slot)}
                className={`w-full rounded-xl px-2 py-2.5 text-sm font-semibold transition ${
                  selected
                    ? 'bg-teal-600 text-white shadow-md shadow-teal-600/30 ring-2 ring-teal-300'
                    : slot.booked
                      ? 'cursor-not-allowed bg-slate-100 text-slate-400 line-through'
                      : 'bg-white text-teal-800 ring-1 ring-teal-100 hover:bg-teal-50 hover:ring-teal-300'
                }`}
              >
                {formatTime(slot.startsAt)}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
