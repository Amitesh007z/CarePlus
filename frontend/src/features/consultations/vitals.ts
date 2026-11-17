import type { ConsultationVitals } from '../../types/clinical';

/** One readable line of vitals. Only values that were actually recorded are shown. */
export function formatVitals(v: ConsultationVitals): string {
  const parts = [
    v.bpSystolic ? `BP ${v.bpSystolic}/${v.bpDiastolic}` : null,
    v.pulse ? `pulse ${v.pulse}` : null,
    v.temperatureC ? `${v.temperatureC} °C` : null,
    v.spo2 ? `SpO₂ ${v.spo2}%` : null,
  ].filter(Boolean);
  return parts.join(' · ') || 'No vitals';
}
