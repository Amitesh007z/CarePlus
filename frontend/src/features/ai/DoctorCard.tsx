import { Link } from 'react-router-dom';
import { Stethoscope } from 'lucide-react';
import type { RecommendedDoctor } from './types';

/** Links to the existing doctor page, where booking already happens with its own confirmation. Never books here. */
export function DoctorCard({ doctor }: { doctor: RecommendedDoctor }) {
  return (
    <article className="flex flex-col gap-3 rounded-2xl border border-white/70 bg-white p-5 shadow-sm ring-1 ring-slate-900/5">
      <div className="flex items-center gap-3">
        <span className="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-teal-500 to-emerald-400 text-white shadow-md shadow-teal-600/20">
          <Stethoscope className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h3 className="font-semibold text-ink">{doctor.displayName}</h3>
          <p className="text-xs text-slate-500">
            {doctor.specialty} · {doctor.experienceYears} yrs experience
          </p>
        </div>
      </div>
      <p className="text-sm text-slate-700">{doctor.reason}</p>
      <Link
        to={`/doctors/${doctor.id}`}
        className="self-start rounded-xl bg-white px-4 py-2 text-sm font-semibold text-teal-800 ring-1 ring-teal-200 hover:bg-teal-50"
      >
        View doctor and book
      </Link>
    </article>
  );
}
