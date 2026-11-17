import { Button } from '../../components/ui/Button';
import type { RecommendedProduct, Availability } from './types';

const AVAILABILITY: Record<Availability, { label: string; cls: string }> = {
  IN_STOCK: { label: 'In stock', cls: 'bg-emerald-50 text-emerald-700' },
  LOW_STOCK: { label: 'Low stock', cls: 'bg-amber-50 text-amber-800' },
  OUT_OF_STOCK: { label: 'Out of stock', cls: 'bg-slate-100 text-slate-500' },
};

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });

/** OTC item. "Add to cart" only asks for confirmation; the page performs the cart call after the patient agrees. */
export function ProductCard({ product, onAddToCart }: { product: RecommendedProduct; onAddToCart: (p: RecommendedProduct) => void }) {
  const avail = AVAILABILITY[product.availability];
  return (
    <article className="flex flex-col gap-3 rounded-2xl border border-white/70 bg-white p-5 shadow-sm ring-1 ring-slate-900/5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-ink">{product.name}</h3>
          <p className="text-xs text-slate-500">
            {[product.form, product.strength].filter(Boolean).join(' · ')} · SKU {product.sku}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-teal-50 px-2.5 py-1 text-xs font-semibold text-teal-800 ring-1 ring-teal-100">OTC</span>
      </div>
      <p className="text-sm text-slate-700">{product.reason}</p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-ink">{inr.format(product.priceInr)}</span>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${avail.cls}`}>{avail.label}</span>
        </div>
        <Button
          onClick={() => onAddToCart(product)}
          disabled={product.availability === 'OUT_OF_STOCK'}
          aria-label={`Add ${product.name} to cart`}
        >
          Add to cart
        </Button>
      </div>
    </article>
  );
}
