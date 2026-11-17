import { AlertTriangle, Phone } from 'lucide-react';

/** Emergency state: guidance only. No product or doctor cards are rendered alongside it. */
export function EmergencyPanel({ message }: { message: string }) {
  return (
    <div role="alert" className="overflow-hidden rounded-2xl bg-gradient-to-br from-rose-600 to-red-700 p-5 text-white shadow-lg shadow-rose-600/30">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-6 shrink-0" aria-hidden="true" />
        <div className="space-y-2">
          <p className="text-lg font-bold">Possible emergency. Get help now.</p>
          <p className="text-sm leading-relaxed text-rose-50">{message}</p>
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Phone className="size-4" aria-hidden="true" /> Call your local emergency number now.
          </p>
        </div>
      </div>
    </div>
  );
}
