import { Link, useSearchParams } from 'react-router-dom';
import { ChevronRight, Package } from 'lucide-react';
import { PageLoader } from '../../components/PageLoader';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { formatDateTime } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import type { PageMeta } from '../../types/clinical';
import { Hero } from '../dashboards/RoleDashboard';
import { inr, ORDER_STATUS_LABEL, ORDER_STATUS_TONE, type OrderSummary } from './types';

/** The patient's order history, newest first. The page number is kept in the URL. */
export function OrdersPage() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const list = useApi<{ items: OrderSummary[]; meta: PageMeta }>(`/api/v1/patients/me/orders?page=${page}&pageSize=10`);

  return (
    <div className="space-y-8">
      <Hero role="PATIENT" title="Your orders" subtitle="Track every medicine order from placed to delivered." />
      {list.loading && <PageLoader label="Loading orders" />}
      {list.error && (
        <Card className="mx-auto max-w-lg text-center">
          <p role="alert" className="text-sm font-medium text-ink">{list.error}</p>
          <Button variant="secondary" className="mt-4" onClick={list.reload}>Try again</Button>
        </Card>
      )}
      {list.data && list.data.items.length === 0 && (
        <Card className="mx-auto max-w-lg text-center">
          <Package className="mx-auto size-10 text-teal-600" aria-hidden="true" />
          <p className="mt-3 font-semibold text-ink">No orders yet</p>
          <Link to="/medicines" className="mt-3 inline-block text-sm font-semibold text-teal-700 hover:underline">Browse medicines</Link>
        </Card>
      )}
      {list.data && list.data.items.length > 0 && (
        <>
          <ul className="space-y-3">
            {list.data.items.map((o) => (
              <li key={o.id}>
                <Link to={`/orders/${o.id}`} className="flex items-center justify-between gap-4 rounded-2xl bg-white/90 p-5 shadow-sm ring-1 ring-slate-900/5 transition hover:ring-teal-300">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">{o.orderNumber} {o.isPrescriptionOrder && <span className="ml-1 text-xs font-medium text-indigo-800">Prescription</span>}</p>
                    <p className="text-xs text-slate-500">{formatDateTime(o.placedAt)} · {o.itemCount} item{o.itemCount === 1 ? '' : 's'}</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className={`hidden rounded-full px-2.5 py-1 text-xs font-semibold ring-1 sm:inline ${ORDER_STATUS_TONE[o.status]}`}>{ORDER_STATUS_LABEL[o.status]}</span>
                    <span className="font-semibold text-ink">{inr(o.totalInr)}</span>
                    <ChevronRight className="size-4 text-slate-400" aria-hidden="true" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <nav aria-label="Pagination" className="flex items-center justify-between">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setParams({ page: String(page - 1) })}>Previous</Button>
            <p className="text-sm text-slate-600">Page {list.data.meta.page} of {list.data.meta.totalPages}</p>
            <Button variant="secondary" disabled={page >= list.data.meta.totalPages} onClick={() => setParams({ page: String(page + 1) })}>Next</Button>
          </nav>
        </>
      )}
    </div>
  );
}
