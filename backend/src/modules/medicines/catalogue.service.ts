import { audit, type AuditContext } from '../../common/audit.js';
import { AppError, notFound } from '../../common/errors/AppError.js';
import { pageWindow, type PageMeta, type PageQuery, pageMeta } from '../../common/http.js';
import type { Database, Queryable } from '../../infrastructure/database/pool.js';
import { enqueueSync, medicineRecord } from '../search/search-sync.js';
import { INDEX_MEDICINES, SearchProviderError, type SearchProvider } from '../search/search-provider.js';
import type { CatalogueQuery, InteractionCreate, MedicineCreate, MedicineUpdate } from './catalogue.schemas.js';

/** At or below this many units the UI shows "low stock". Stock itself is never indexed for search. */
export const LOW_STOCK_THRESHOLD = 10;
const MAX_SEARCH_CANDIDATES = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Availability = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';
export const availabilityOf = (stock: number): Availability =>
  stock <= 0 ? 'OUT_OF_STOCK' : stock <= LOW_STOCK_THRESHOLD ? 'LOW_STOCK' : 'IN_STOCK';

/** Public view: no exact stock count, no internal flags. */
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

interface Row {
  id: string;
  sku: string;
  name: string;
  strength: string | null;
  form: string;
  category: string;
  pack_size: string;
  price_inr: string;
  stock_qty: number;
  rx_required: boolean;
  allergy_class: string | null;
  description: string | null;
  manufacturer: string | null;
  active: boolean;
  chronic_eligible: boolean;
  created_at: Date;
  updated_at: Date;
}

const COLS = `id, sku, name, strength, form, category, pack_size, price_inr, stock_qty, rx_required, allergy_class,
  description, manufacturer, active, chronic_eligible, created_at, updated_at`;

export const toPublic = (r: Row): PublicMedicine => ({
  id: r.id,
  sku: r.sku,
  name: r.name,
  strength: r.strength,
  form: r.form,
  category: r.category,
  packSize: r.pack_size,
  priceInr: Number(r.price_inr),
  rxRequired: r.rx_required,
  allergyClass: r.allergy_class,
  description: r.description,
  manufacturer: r.manufacturer,
  availability: availabilityOf(r.stock_qty),
});

const toAdmin = (r: Row): AdminMedicine => ({
  ...toPublic(r),
  stockQty: r.stock_qty,
  active: r.active,
  chronicEligible: r.chronic_eligible,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);

interface Filters {
  /** Text match for the PostgreSQL path (name, SKU, category). */
  q?: string;
  /** Restricts to these IDs, used when a search engine has already matched the text. */
  ids?: string[];
  category?: string;
  rx: 'all' | 'rx' | 'otc';
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  /** Public listings are always 'active'. Only the admin listing may ask for 'inactive' or 'any'. */
  activity: 'active' | 'inactive' | 'any';
}

type Sort = 'relevance' | 'name' | 'price_asc' | 'price_desc';

/**
 * Single query path for every listing. PostgreSQL applies every filter and the sort, so results are
 * correct even when a search index is stale. Inputs are bound parameters; only fixed SQL fragments are concatenated.
 */
async function queryMedicines(db: Queryable, f: Filters, sort: Sort, page: PageQuery): Promise<{ rows: Row[]; total: number }> {
  const params: unknown[] = [];
  const cond: string[] = [];
  const bind = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.activity === 'active') cond.push('active');
  else if (f.activity === 'inactive') cond.push('NOT active');
  if (f.q) {
    const p = bind(`%${escapeLike(f.q)}%`);
    cond.push(`(name ILIKE ${p} OR sku ILIKE ${p} OR category ILIKE ${p})`);
  }
  let idsParam: string | null = null;
  if (f.ids) {
    idsParam = bind(f.ids);
    cond.push(`id = ANY(${idsParam}::uuid[])`);
  }
  if (f.category) cond.push(`lower(category) = lower(${bind(f.category)})`);
  if (f.rx === 'rx') cond.push('rx_required');
  if (f.rx === 'otc') cond.push('NOT rx_required');
  if (f.minPrice !== undefined) cond.push(`price_inr >= ${bind(f.minPrice)}`);
  if (f.maxPrice !== undefined) cond.push(`price_inr <= ${bind(f.maxPrice)}`);
  if (f.inStock) cond.push('stock_qty > 0');
  const where = `WHERE ${cond.length ? cond.join(' AND ') : 'TRUE'}`;

  const order =
    sort === 'price_asc' ? 'price_inr ASC, name ASC'
    : sort === 'price_desc' ? 'price_inr DESC, name ASC'
    : sort === 'relevance' && idsParam ? `array_position(${idsParam}::uuid[], id) ASC`
    : 'name ASC';

  const w = pageWindow(page);
  const limitP = bind(w.limit);
  const offsetP = bind(w.offset);
  const [rows, count] = await Promise.all([
    db.query<Row>(`SELECT ${COLS} FROM medicines ${where} ORDER BY ${order} LIMIT ${limitP} OFFSET ${offsetP}`, params),
    db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM medicines ${where}`, params.slice(0, params.length - 2)),
  ]);
  return { rows: rows.rows, total: count.rows[0]?.n ?? 0 };
}

const filtersFrom = (q: CatalogueQuery): Filters => ({
  q: q.q || undefined,
  category: q.category || undefined,
  rx: q.rx,
  minPrice: q.minPrice,
  maxPrice: q.maxPrice,
  inStock: q.inStock === 'true',
  activity: 'active',
});

/** Public catalogue listing from PostgreSQL. Also the fallback when search is unavailable. */
export async function listCatalogue(db: Queryable, query: CatalogueQuery): Promise<{ items: PublicMedicine[]; meta: PageMeta }> {
  const sort: Sort = query.sort === 'price_asc' || query.sort === 'price_desc' ? query.sort : 'name';
  const { rows, total } = await queryMedicines(db, filtersFrom(query), sort, query);
  return { items: rows.map(toPublic), meta: pageMeta(query, total) };
}

export interface SearchOutcome {
  items: PublicMedicine[];
  meta: PageMeta;
  /** algolia: ranking came from the search index. postgres: the database answered. */
  engine: 'algolia' | 'postgres';
  /** True when a search was requested but the provider failed, so PostgreSQL answered instead. */
  degraded: boolean;
  /** True when the provider had more matches than the candidate cap. */
  truncated: boolean;
}

/**
 * Search: the provider ranks and matches text (typo-tolerant); PostgreSQL then filters, sorts and pages.
 * The provider never decides what is shown, only the order of candidates. Stock-only filtering uses
 * PostgreSQL, because stock is deliberately not indexed.
 */
export async function searchCatalogue(db: Database, provider: SearchProvider | null, query: CatalogueQuery): Promise<SearchOutcome> {
  const sort: Sort = query.sort ?? (query.q ? 'relevance' : 'name');
  const f = filtersFrom(query);
  const fromPostgres = async (degraded: boolean): Promise<SearchOutcome> => {
    const { rows, total } = await queryMedicines(db, f, sort === 'relevance' ? 'name' : sort, query);
    return { items: rows.map(toPublic), meta: pageMeta(query, total), engine: 'postgres', degraded, truncated: false };
  };
  if (!f.q || !provider || f.inStock) return fromPostgres(false);

  // Only the provider call is guarded. Any failure there degrades to the database answer; the client sees
  // the flag, never the cause. Database errors below are real faults and are not hidden.
  let hit: { ids: string[]; nbHits: number };
  try {
    hit = await provider.searchIds(INDEX_MEDICINES, f.q, MAX_SEARCH_CANDIDATES);
  } catch (err) {
    if (!(err instanceof SearchProviderError)) throw err;
    return fromPostgres(true);
  }
  const ids = hit.ids.filter((id) => UUID_RE.test(id));
  if (ids.length === 0) return { items: [], meta: pageMeta(query, 0), engine: 'algolia', degraded: false, truncated: false };
  const { rows, total } = await queryMedicines(db, { ...f, q: undefined, ids }, sort, query);
  return { items: rows.map(toPublic), meta: pageMeta(query, total), engine: 'algolia', degraded: false, truncated: hit.nbHits > ids.length };
}

export async function getPublicMedicine(db: Queryable, id: string): Promise<PublicMedicine> {
  const r = await db.query<Row>(`SELECT ${COLS} FROM medicines WHERE id = $1 AND active`, [id]);
  if (!r.rows[0]) throw notFound('Medicine not found');
  return toPublic(r.rows[0]);
}

export async function listCategories(db: Queryable): Promise<string[]> {
  const r = await db.query<{ category: string }>('SELECT DISTINCT category FROM medicines WHERE active ORDER BY category');
  return r.rows.map((x) => x.category);
}

// ---- Admin catalogue -----------------------------------------------------------------------------

export async function listAdminMedicines(db: Queryable, q: PageQuery & { q?: string; active: 'true' | 'false' | 'all' }) {
  const activity = q.active === 'all' ? 'any' : q.active === 'true' ? 'active' : 'inactive';
  const { rows, total } = await queryMedicines(db, { q: q.q || undefined, rx: 'all', activity }, 'name', q);
  return { items: rows.map(toAdmin), meta: pageMeta(q, total) };
}

export async function getAdminMedicine(db: Queryable, id: string): Promise<AdminMedicine> {
  const r = await db.query<Row>(`SELECT ${COLS} FROM medicines WHERE id = $1`, [id]);
  if (!r.rows[0]) throw notFound('Medicine not found');
  return toAdmin(r.rows[0]);
}

const COLUMN_FOR: Record<keyof MedicineUpdate, string> = {
  sku: 'sku',
  name: 'name',
  strength: 'strength',
  form: 'form',
  category: 'category',
  packSize: 'pack_size',
  priceInr: 'price_inr',
  rxRequired: 'rx_required',
  allergyClass: 'allergy_class',
  description: 'description',
  manufacturer: 'manufacturer',
  chronicEligible: 'chronic_eligible',
  active: 'active',
};

/** The part of a medicine that the search index holds. A change here (or to active) queues a sync. */
const indexKey = (r: Row) => JSON.stringify({ active: r.active, record: r.active ? medicineRecord(r) : null });

function uniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}

/**
 * Creates a medicine. The catalogue row and its search job commit together. If the transaction rolls
 * back, no job exists. The provider is never called from here.
 */
export async function createMedicine(db: Database, input: MedicineCreate, ctx: AuditContext): Promise<AdminMedicine> {
  const id = await db.transaction(async (tx) => {
    let row: Row;
    try {
      const r = await tx.query<Row>(
        `INSERT INTO medicines (sku, name, strength, form, category, pack_size, price_inr, stock_qty, rx_required,
            allergy_class, description, manufacturer, active, chronic_eligible)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING ${COLS}`,
        [
          input.sku, input.name, input.strength, input.form, input.category, input.packSize, input.priceInr,
          input.initialStock, input.rxRequired, input.allergyClass, input.description, input.manufacturer,
          input.active, input.chronicEligible,
        ],
      );
      row = r.rows[0]!;
    } catch (err) {
      if (uniqueViolation(err)) throw new AppError(409, 'DUPLICATE_SKU', 'A medicine with this SKU already exists');
      throw err;
    }
    if (row.stock_qty > 0) {
      await tx.query(
        `INSERT INTO stock_movements (medicine_id, delta, balance_after, reason, note, actor_user_id)
         VALUES ($1, $2, $2, 'ADJUSTMENT', 'Opening stock', $3)`,
        [row.id, row.stock_qty, ctx.actorId],
      );
    }
    if (row.active) await enqueueSync(tx, INDEX_MEDICINES, row.id);
    await audit(tx, ctx, { action: 'MEDICINE_CREATED', entityType: 'medicine', entityId: row.id, after: { sku: row.sku, active: row.active } });
    return row.id;
  });
  return getAdminMedicine(db, id);
}

export async function updateMedicine(db: Database, id: string, patch: MedicineUpdate, ctx: AuditContext): Promise<AdminMedicine> {
  await db.transaction(async (tx) => {
    const cur = (await tx.query<Row>(`SELECT ${COLS} FROM medicines WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!cur) throw notFound('Medicine not found');
    const keys = Object.keys(patch) as (keyof MedicineUpdate)[];
    const params: unknown[] = [id];
    const sets = keys.map((k) => {
      params.push(patch[k] ?? null);
      return `${COLUMN_FOR[k]} = $${params.length}`;
    });
    let updated: Row;
    try {
      updated = (await tx.query<Row>(`UPDATE medicines SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLS}`, params)).rows[0]!;
    } catch (err) {
      if (uniqueViolation(err)) throw new AppError(409, 'DUPLICATE_SKU', 'A medicine with this SKU already exists');
      throw err;
    }
    // Stock, chronic eligibility and timestamps are not indexed, so only real index changes queue a sync.
    if (indexKey(cur) !== indexKey(updated)) await enqueueSync(tx, INDEX_MEDICINES, id);
    await audit(tx, ctx, { action: 'MEDICINE_UPDATED', entityType: 'medicine', entityId: id, after: { changed: keys } });
  });
  return getAdminMedicine(db, id);
}

/** Soft delete. The record stays for prescriptions and history; search removes it through the outbox. */
export async function deactivateMedicine(db: Database, id: string, ctx: AuditContext): Promise<AdminMedicine> {
  return updateMedicine(db, id, { active: false }, ctx);
}

// ---- Drug interactions (curated rules; none are invented in code) ---------------------------------

export interface InteractionView {
  severity: 'MAJOR' | 'MODERATE' | 'MINOR';
  effect: string;
  sourceReference: string;
  medicines: { id: string; name: string }[];
}

/** Active rules that apply to any pair within the given medicines. */
export async function interactionsAmong(db: Queryable, medicineIds: string[]): Promise<InteractionView[]> {
  if (medicineIds.length < 2) return [];
  const r = await db.query<{ severity: InteractionView['severity']; effect: string; source_reference: string; a_id: string; a_name: string; b_id: string; b_name: string }>(
    `SELECT i.severity, i.effect, i.source_reference, a.id AS a_id, a.name AS a_name, b.id AS b_id, b.name AS b_name
       FROM drug_interactions i
       JOIN medicines a ON a.id = i.medicine_a_id
       JOIN medicines b ON b.id = i.medicine_b_id
      WHERE i.active AND i.medicine_a_id = ANY($1::uuid[]) AND i.medicine_b_id = ANY($1::uuid[])
      ORDER BY i.severity, a.name`,
    [medicineIds],
  );
  return r.rows.map((x) => ({
    severity: x.severity,
    effect: x.effect,
    sourceReference: x.source_reference,
    medicines: [
      { id: x.a_id, name: x.a_name },
      { id: x.b_id, name: x.b_name },
    ],
  }));
}

export async function createInteraction(db: Database, input: InteractionCreate, ctx: AuditContext): Promise<InteractionView[]> {
  const a = input.medicineAId.toLowerCase();
  const b = input.medicineBId.toLowerCase();
  const [lo, hi] = a < b ? [a, b] : [b, a];
  await db.transaction(async (tx) => {
    try {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO drug_interactions (medicine_a_id, medicine_b_id, severity, effect, source_reference)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [lo, hi, input.severity, input.effect, input.sourceReference],
      );
      await audit(tx, ctx, { action: 'INTERACTION_RULE_CREATED', entityType: 'drug_interaction', entityId: r.rows[0]!.id, after: { severity: input.severity } });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') throw new AppError(409, 'DUPLICATE_INTERACTION', 'A rule for this pair already exists');
      if (code === '23503') throw new AppError(422, 'INVALID_MEDICINE', 'One of the medicines does not exist');
      throw err;
    }
  });
  return interactionsAmong(db, [lo, hi]);
}

/** Medicines on a draft that are not eligible for a 90-day validity. Empty means 90 days is allowed. */
export async function chronicIneligible(db: Queryable, medicineIds: string[]): Promise<{ id: string; name: string }[]> {
  if (medicineIds.length === 0) return [];
  const r = await db.query<{ id: string; name: string }>(
    'SELECT id, name FROM medicines WHERE id = ANY($1::uuid[]) AND NOT chronic_eligible ORDER BY name',
    [medicineIds],
  );
  return r.rows;
}
