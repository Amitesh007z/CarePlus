/** The two search indexes. Names are fixed by the brief; objectID is always the PostgreSQL UUID. */
export const INDEX_MEDICINES = 'carepulse_medicines' as const;
export const INDEX_DOCTORS = 'carepulse_doctors' as const;
export type IndexName = typeof INDEX_MEDICINES | typeof INDEX_DOCTORS;

/** Medicine record: catalogue facts only. Stock, prices of other rows and any patient data are never indexed. */
export interface MedicineRecord {
  objectID: string;
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
}

/** Doctor record: public directory fields only. No registration number, email, mobile or availability. */
export interface DoctorRecord {
  objectID: string;
  displayName: string;
  specialty: string;
  experienceYears: number;
}

export type IndexRecord = MedicineRecord | DoctorRecord;

export interface SearchHit {
  objectID: string;
}

/**
 * Provider port. The Algolia adapter implements it; tests use an in-memory fake. Implementations must
 * honour timeouts and must never put provider response bodies or credentials into error messages.
 */
export interface SearchProvider {
  /** Creates or replaces whole objects (idempotent for the same objectID). */
  saveObjects(index: IndexName, records: IndexRecord[]): Promise<void>;
  /** Removes objects. Removing a missing object is not an error. */
  deleteObjects(index: IndexName, objectIds: string[]): Promise<void>;
  /** Ranked, typo-tolerant text match. Returns object IDs only, most relevant first. */
  searchIds(index: IndexName, query: string, limit: number): Promise<{ ids: string[]; nbHits: number }>;
  /** Every objectID currently in the index. Used by reconciliation. */
  listObjectIds(index: IndexName): Promise<string[]>;
  /** Applies index settings (searchable attributes, retrieval). Idempotent. */
  configure(index: IndexName): Promise<void>;
}

export type SearchErrorKind = 'TIMEOUT' | 'UNAVAILABLE' | 'REJECTED' | 'NOT_CONFIGURED';

/** Safe to expose as a code. `message` is generic; `status` is the HTTP status when there was one. */
export class SearchProviderError extends Error {
  constructor(
    public readonly kind: SearchErrorKind,
    public readonly status: number | null = null,
  ) {
    super(
      kind === 'TIMEOUT'
        ? 'Search provider timed out'
        : kind === 'NOT_CONFIGURED'
          ? 'Search provider is not configured'
          : 'Search provider is unavailable',
    );
    this.name = 'SearchProviderError';
  }

  /** Short, non-sensitive code stored in search_sync_jobs.last_error. */
  get code(): string {
    return this.status ? `${this.kind}_${this.status}` : this.kind;
  }
}

/** Public search settings. Only what the search needs, so the index stays small. */
export const INDEX_SETTINGS: Record<IndexName, Record<string, unknown>> = {
  carepulse_medicines: {
    searchableAttributes: ['name', 'unordered(sku)', 'category', 'form', 'strength', 'description', 'manufacturer'],
    attributesToRetrieve: ['objectID'],
  },
  carepulse_doctors: {
    searchableAttributes: ['displayName', 'specialty'],
    attributesToRetrieve: ['objectID'],
  },
};
