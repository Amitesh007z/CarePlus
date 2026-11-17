import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Clock3 } from 'lucide-react';
import { PageLoader } from '../../components/PageLoader';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import type { Slot, DoctorDetail } from '../../types/clinical';
import { useApi } from '../../lib/useApi';
import { WEEKDAYS, timeRange } from '../../lib/format';
import { Hero } from '../dashboards/RoleDashboard';
import { BookingForm } from './BookingForm';
import { SlotPicker } from './SlotPicker';

export default function DoctorDetailPage() {
  const { doctorId = '' } = useParams();
  const doctor = useApi<DoctorDetail>(`/api/v1/doctors/${doctorId}`);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [pickerKey, setPickerKey] = useState(0);

  if (doctor.loading) return <PageLoader label="Loading doctor" />;
  if (doctor.error || !doctor.data) {
    return (
      <Card className="mx-auto max-w-lg text-center">
        <p role="alert" className="text-sm text-rose-700">{doctor.error ?? 'Doctor not found.'}</p>
        <Link to="/doctors" className="mt-4 inline-block text-sm font-semibold text-teal-700 hover:underline">Back to doctors</Link>
      </Card>
    );
  }

  const d = doctor.data;
  return (
    <div className="space-y-8">
      <Link to="/doctors" className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-800 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> All doctors
      </Link>
      <Hero role="PATIENT" title={d.displayName} subtitle={`${d.specialty} · ${d.experienceYears} years of experience`} />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Choose a time" description="Times are in India Standard Time (IST).">
          <SlotPicker key={pickerKey} doctorId={d.id} selectedId={slot?.id ?? null} onSelect={setSlot} />
        </Card>

        <Card title="Weekly hours" description="When this doctor sees patients.">
          <ul className="space-y-3">
            {d.availability.map((a, i) => (
              <li key={`${a.weekday}-${i}`} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
                <span className="font-semibold text-ink">{WEEKDAYS[a.weekday]}</span>
                <span className="flex items-center gap-1.5 text-slate-600">
                  <Clock3 className="size-3.5" aria-hidden="true" />
                  {timeRange(a.startTime, a.endTime)} · {a.slotMinutes} min
                </span>
              </li>
            ))}
            {d.availability.length === 0 && <li className="text-sm text-slate-500">No hours published yet.</li>}
          </ul>
        </Card>
      </div>

      {slot && (
        <Card
          title="Your visit details"
          description="Describe what you are experiencing. The doctor makes the diagnosis."
          actions={
            <Button variant="ghost" onClick={() => { setSlot(null); setPickerKey((k) => k + 1); }}>
              Change time
            </Button>
          }
        >
          <BookingForm doctor={d} slot={slot} onBooked={() => { setSlot(null); setPickerKey((k) => k + 1); }} />
        </Card>
      )}
    </div>
  );
}
