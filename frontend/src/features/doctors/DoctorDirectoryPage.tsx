import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Search, Stethoscope } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { useApi } from '../../lib/useApi';
import type { DoctorSummary, PageMeta } from '../../types/clinical';
import { Hero } from '../dashboards/RoleDashboard';

interface DirectoryResponse {
  items: DoctorSummary[];
  meta: PageMeta;
}

const initials = (name: string) =>
  name.replace(/^Dr\.?\s*/i, '').split(' ').map((p) => p[0] ?? '').join('').slice(0, 2).toUpperCase();

export default function DoctorDirectoryPage() {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  // Debounce typing so each keystroke does not hit the API.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(input.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [input]);

  const params = new URLSearchParams({ page: String(page), pageSize: '12' });
  if (query) params.set('query', query);
  const { data, error, loading, reload } = useApi<DirectoryResponse>(`/api/v1/doctors?${params.toString()}`);

  return (
    <div className="space-y-8">
      <Hero role="PATIENT" title="Find a doctor" subtitle="Browse our doctors, see their hours and book a time that suits you." />

      <div className="relative max-w-xl">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <input
          type="search"
          aria-label="Search doctors by name or specialty"
          placeholder="Search by name or specialty"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="min-h-12 w-full rounded-2xl border border-slate-200 bg-white/90 pl-12 pr-4 text-sm shadow-sm focus:border-teal-500 focus:ring-4 focus:ring-teal-500/15 focus:outline-none"
        />
      </div>

      {loading && <p role="status" className="text-sm text-slate-500">Finding doctors…</p>}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl bg-rose-50 p-4 text-sm text-rose-800">
          {error} <Button variant="secondary" onClick={reload}>Try again</Button>
        </div>
      )}
      {data && data.items.length === 0 && (
        <Card className="text-center">
          <Stethoscope className="mx-auto size-10 text-teal-500" aria-hidden="true" />
          <p className="mt-3 font-semibold text-ink">No doctors match “{query}”</p>
          <p className="mt-1 text-sm text-slate-500">Try a different name or specialty.</p>
        </Card>
      )}

      {data && data.items.length > 0 && (
        <>
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {data.items.map((d) => (
              <li key={d.id}>
                <Link
                  to={`/doctors/${d.id}`}
                  className="group flex h-full flex-col rounded-2xl border border-white/70 bg-white/90 p-6 shadow-sm ring-1 ring-slate-900/5 transition duration-300 hover:-translate-y-1 hover:shadow-xl"
                >
                  <div className="flex items-center gap-4">
                    <span className="grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-sky-500 text-lg font-bold text-white shadow-md shadow-indigo-500/25">
                      {initials(d.displayName)}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink">{d.displayName}</p>
                      <p className="text-sm text-slate-500">{d.specialty}</p>
                    </div>
                  </div>
                  <div className="mt-5 flex items-center justify-between">
                    <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700">{d.experienceYears} yrs experience</span>
                    <span className="text-sm font-semibold text-teal-700 transition group-hover:translate-x-0.5">View &amp; book →</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          <nav aria-label="Pagination" className="flex items-center justify-between">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="size-4" aria-hidden="true" /> Previous
            </Button>
            <p className="text-sm text-slate-500">Page {data.meta.page} of {data.meta.totalPages}</p>
            <Button variant="secondary" disabled={page >= data.meta.totalPages} onClick={() => setPage((p) => p + 1)}>
              Next <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </nav>
        </>
      )}
    </div>
  );
}
