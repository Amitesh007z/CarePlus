import type { PageMeta } from '../../types/clinical';

export type Availability = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';

/** Public view. Exact stock is never sent to the browser. */
export interface PublicMedicine {
  id: string;
  sku: string;
  name: string;
  strength: string | null;
  form: string;
  category: string;
  packSize: string;
  priceInr: number;
  rxRequired: boolean;
  allergyClass: string | null;
  description: string | null;
  manufacturer: string | null;
  availability: Availability;
}

export interface AdminMedicine extends PublicMedicine {
  stockQty: number;
  active: boolean;
  chronicEligible: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogueListing {
  items: PublicMedicine[];
  meta: PageMeta;
}

export interface CatalogueResult extends CatalogueListing {
  /** True when a search was requested but the standard catalogue answered instead. */
  degraded: boolean;
}

export const AVAILABILITY_LABEL: Record<Availability, string> = {
  IN_STOCK: 'In stock',
  LOW_STOCK: 'Low stock',
  OUT_OF_STOCK: 'Out of stock',
};

export const AVAILABILITY_TONE: Record<Availability, string> = {
  IN_STOCK: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  LOW_STOCK: 'bg-amber-50 text-amber-900 ring-amber-200',
  OUT_OF_STOCK: 'bg-slate-100 text-slate-600 ring-slate-200',
};
