import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, RotateCcw, Search } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { apiRequest } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import { messageOf, useApi } from '../../lib/useApi';
import { AVAILABILITY_LABEL, AVAILABILITY_TONE, type CatalogueListing, type CatalogueResult, type PublicMedicine } from './types';

const PAGE_SIZE = 12;
const RX_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'rx', label: 'Rx only' },
  { value: 'otc', label: 'OTC' },
] as const;

const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';

/**
 * Search first; if the search request itself fails, answer from the standard catalogue with the same filters.
 * The server also reports `degraded` when its search provider was down, and that is shown as a notice.
 */
async function loadCatalogue(params: URLSearchParams, signal: AbortSignal): Promise<CatalogueResult> {
  const qs = new URLSearchParams(params);
  qs.set('pageSize', String(PAGE_SIZE));
  if (qs.has('q')) {
    try {
      return await apiRequest<CatalogueResult>(`/api/v1/catalogue/search?${qs}`, { signal });
    } catch (err) {
      if (isAbort(err)) throw err;
    }
    const listing = await apiRequest<CatalogueListing>(`/api/v1/catalogue/medicines?${qs}`, { signal });
    return { ...listing, degraded: true };
  }
  const listing = await apiRequest<CatalogueListing>(`/api/v1/catalogue/medicines?${qs}`, { signal });
  return { ...listing, degraded: false };
}

/** Public medicine catalogue. Filters live in the URL, so a filtered view can be shared. */
export default function CataloguePage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const queryKey = params.toString();
  const [text, setText] = useState(q);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ loading: boolean; error: string | null; result: CatalogueResult | null }>({
    loading: true,
    error: null,
    result: null,
  });

  const update = useCallback(
    (changes: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(changes)) {
            if (value === null || value === '') next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // Search-as-you-type: the URL follows the typed text after 300 ms of quiet, so one burst makes one request.
  useEffect(() => {
    const next = text.trim();
    if (next === q) return;
    const timer = setTimeout(() => update({ q: next, page: null }), 300);
    return () => clearTimeout(timer);
  }, [text, q, update]);

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    loadCatalogue(new URLSearchParams(queryKey), controller.signal)
      .then((result) => setState({ loading: false, error: null, result }))
      .catch((err: unknown) => {
        if (!isAbort(err)) setState({ loading: false, error: messageOf(err), result: null });
      });
    return () => controller.abort();
  }, [queryKey, attempt]);

  const categories = useApi<{ items: string[] }>('/api/v1/catalogue/categories');
  const { loading, error, result } = state;
  const filtersActive = ['q', 'category', 'rx', 'minPrice', 'maxPrice'].some((k) => params.has(k));
  const noResults = !loading && !error && result !== null && result.items.length === 0;
  const featured = useApi<CatalogueListing>(noResults ? `/api/v1/catalogue/medicines?pageSize=4` : null);

  function clearFilters() {
    setText('');
    setParams(new URLSearchParams(), { replace: true });
  }

  const sortOptions = [
    ...(q ? [{ value: 'relevance', label: 'Best match' }] : []),
    { value: 'name', label: 'Name A–Z' },
    { value: 'price_asc', label: 'Price: low to high' },
    { value: 'price_desc', label: 'Price: high to low' },
  ];
  const rx = params.get('rx') ?? 'all';
  const category = params.get('category') ?? '';
  const page = result?.meta.page ?? 1;

  return (
    <div className="space-y-8">
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-teal-600 via-emerald-500 to-sky-500 p-7 text-white shadow-xl shadow-teal-900/10 sm:p-10">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/80">CarePulse · pharmacy</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Medicine catalogue</h1>
        <p className="mt-2 max-w-2xl text-sm text-white/90">Search by name, SKU or category. Prices are synthetic demo prices. Prescription medicines need a valid prescription.</p>
      </section>

      <Card>
        <div className="space-y-5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search medicines"
              placeholder="Search medicines, e.g. amoxicillin"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="min-h-11 w-full rounded-xl border border-slate-200 bg-white/90 pl-11 pr-4 text-sm shadow-sm focus:border-teal-500 focus:ring-4 focus:ring-teal-500/15 focus:outline-none"
            />
          </div>

          <div role="group" aria-label="Category" className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={category === ''}
              onClick={() => update({ category: null, page: null })}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium ring-1 transition ${category === '' ? 'bg-teal-600 text-white ring-teal-600' : 'bg-white text-ink ring-slate-200 hover:ring-teal-300'}`}
            >
              All categories
            </button>
            {categories.data?.items.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={category === c}
                onClick={() => update({ category: c, page: null })}
                className={`rounded-full px-3.5 py-1.5 text-sm font-medium ring-1 transition ${category === c ? 'bg-teal-600 text-white ring-teal-600' : 'bg-white text-ink ring-slate-200 hover:ring-teal-300'}`}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div role="group" aria-label="Prescription type" className="flex items-end gap-1 rounded-xl bg-slate-100 p-1">
              {RX_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={rx === o.value}
                  onClick={() => update({ rx: o.value === 'all' ? null : o.value, page: null })}
                  className={`min-h-9 flex-1 rounded-lg px-3 text-sm font-semibold transition ${rx === o.value ? 'bg-white text-ink shadow-sm' : 'text-slate-600 hover:text-ink'}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <Input label="Min price (₹)" type="number" inputMode="numeric" min={0} value={params.get('minPrice') ?? ''} onChange={(e) => update({ minPrice: e.target.value, page: null })} />
            <Input label="Max price (₹)" type="number" inputMode="numeric" min={0} value={params.get('maxPrice') ?? ''} onChange={(e) => update({ maxPrice: e.target.value, page: null })} />
            <Select label="Sort by" value={params.get('sort') ?? (q ? 'relevance' : 'name')} options={sortOptions} onChange={(e) => update({ sort: e.target.value, page: null })} />
            <div className="flex items-end">
              <Button variant="secondary" onClick={clearFilters} disabled={!filtersActive} className="w-full">
                <RotateCcw className="size-4" aria-hidden="true" /> Clear filters
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {result?.degraded && (
        <p role="status" className="flex items-center gap-2 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" /> Live search is unavailable; showing the standard catalogue.
        </p>
      )}
      {loading && <p role="status" className="text-sm text-slate-500">Searching…</p>}
      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-sm text-rose-900">
          <span>{error}</span>
          <Button variant="secondary" onClick={() => setAttempt((a) => a + 1)}>Try again</Button>
        </div>
      )}

      {result && result.items.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy={loading || undefined}>
          {result.items.map((m) => (
            <MedicineCard key={m.id} medicine={m} />
          ))}
        </ul>
      )}

      {noResults && (
        <Card title="No medicines match these filters" description="Try a different spelling, or remove a filter.">
          <div className="space-y-5">
            <Button variant="secondary" onClick={clearFilters}><RotateCcw className="size-4" aria-hidden="true" /> Clear filters</Button>
            {featured.data && featured.data.items.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-ink">Popular medicines</p>
                <ul className="mt-2 grid gap-3 sm:grid-cols-2">
                  {featured.data.items.map((m) => (
                    <MedicineCard key={m.id} medicine={m} />
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
      )}

      {result && result.meta.totalPages > 1 && (
        <nav aria-label="Pagination" className="flex items-center justify-between gap-3">
          <Button variant="secondary" disabled={page <= 1} onClick={() => update({ page: page - 1 === 1 ? null : String(page - 1) })}>Previous</Button>
          <p className="text-sm text-slate-600">Page {page} of {result.meta.totalPages} · {result.meta.total} medicines</p>
          <Button variant="secondary" disabled={page >= result.meta.totalPages} onClick={() => update({ page: String(page + 1) })}>Next</Button>
        </nav>
      )}
    </div>
  );
}

function MedicineCard({ medicine: m }: { medicine: PublicMedicine }) {
  return (
    <li className="flex flex-col gap-3 rounded-2xl bg-white/90 p-5 shadow-sm ring-1 ring-slate-900/5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-ink">{m.name}</h3>
          <p className="text-xs text-slate-500">{m.sku} · {m.category}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${m.rxRequired ? 'bg-indigo-50 text-indigo-800 ring-indigo-200' : 'bg-slate-50 text-slate-700 ring-slate-200'}`}>
          {m.rxRequired ? 'Rx' : 'OTC'}
        </span>
      </div>
      <p className="text-sm text-slate-600">{m.form} · {m.packSize}</p>
      {m.description && <p className="line-clamp-2 text-sm text-slate-500">{m.description}</p>}
      <div className="mt-auto flex items-center justify-between gap-3 pt-2">
        <p className="text-lg font-bold text-ink">{formatMoney(m.priceInr)}</p>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${AVAILABILITY_TONE[m.availability]}`}>{AVAILABILITY_LABEL[m.availability]}</span>
      </div>
    </li>
  );
}
