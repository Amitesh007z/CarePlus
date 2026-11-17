import type { Database, Queryable } from '../../infrastructure/database/pool.js';
import {
  INDEX_DOCTORS,
  INDEX_MEDICINES,
  SearchProviderError,
  type DoctorRecord,
  type IndexName,
  type IndexRecord,
  type MedicineRecord,
  type SearchProvider,
} from './search-provider.js';

/**
 * Transactional outbox for search indexing.
 *
 * A job means "make the index match the database for this object". It is inserted in the same
 * transaction as the catalogue change. The worker reads the current row when it runs, so a duplicate or
 * late job can only write the current truth. Writes never wait on the provider.
 */

export const BASE_DELAY_MS = 5_000;
export const MAX_DELAY_MS = 15 * 60_000;
export const DEFAULT_MAX_ATTEMPTS = 6;
export const DEFAULT_BATCH = 50;
export const DEFAULT_CONCURRENCY = 3;
const LEASE_MS = 2 * 60_000;

/** Bounded exponential backoff: 5s, 10s, 20s, 40s, 80s, then capped at 15 minutes. */
export function retryDelayMs(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_DELAY_MS);
}

/** Queues a sync for one object. Duplicate waiting jobs collapse into one (partial unique index). */
export async function enqueueSync(db: Queryable, index: IndexName, objectId: string): Promise<void> {
  await db.query(
    `INSERT INTO search_sync_jobs (index_name, object_id) VALUES ($1, $2)
     ON CONFLICT (index_name, object_id) WHERE status = 'PENDING' DO NOTHING`,
    [index, objectId],
  );
}

/** Record builders: the explicit allow-list of what leaves PostgreSQL for the search provider. */
export interface MedicineRow {
  id: string;
  sku: string;
  name: string;
  strength: string | null;
  form: string;
  category: string;
  pack_size: string;
  price_inr: string;
  rx_required: boolean;
  allergy_class: string | null;
  description: string | null;
  manufacturer: string | null;
}

export const medicineRecord = (r: MedicineRow): MedicineRecord => ({
  objectID: r.id,
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
});

export const doctorRecord = (r: { user_id: string; display_name: string; specialty: string; experience_years: number }): DoctorRecord => ({
  objectID: r.user_id,
  displayName: r.display_name,
  specialty: r.specialty,
  experienceYears: r.experience_years,
});

const MEDICINE_COLUMNS = `id, sku, name, strength, form, category, pack_size, price_inr, rx_required, allergy_class, description, manufacturer`;

/** Loads the current, publishable state. Inactive or missing objects are absent from the map (= remove). */
async function loadRecords(db: Queryable, index: IndexName, ids: string[]): Promise<Map<string, IndexRecord>> {
  const out = new Map<string, IndexRecord>();
  if (ids.length === 0) return out;
  if (index === INDEX_MEDICINES) {
    const r = await db.query<MedicineRow>(`SELECT ${MEDICINE_COLUMNS} FROM medicines WHERE id = ANY($1::uuid[]) AND active`, [ids]);
    for (const row of r.rows) out.set(row.id, medicineRecord(row));
  } else {
    const r = await db.query<{ user_id: string; display_name: string; specialty: string; experience_years: number }>(
      `SELECT d.user_id, d.display_name, d.specialty, d.experience_years
         FROM doctor_profiles d JOIN users u ON u.id = d.user_id
        WHERE d.user_id = ANY($1::uuid[]) AND d.active AND u.status = 'ACTIVE'`,
      [ids],
    );
    for (const row of r.rows) out.set(row.user_id, doctorRecord(row));
  }
  return out;
}

export interface SyncDeps {
  db: Database;
  provider: SearchProvider;
  logger?: { warn: (obj: object, msg: string) => void };
  maxAttempts?: number;
  batchSize?: number;
  concurrency?: number;
  now?: () => Date;
}

export interface DrainReport {
  claimed: number;
  succeeded: number;
  retried: number;
  dead: number;
  superseded: number;
}

interface ClaimedJob {
  id: string;
  indexName: IndexName;
  objectId: string;
  attempts: number;
}

const emptyReport = (): DrainReport => ({ claimed: 0, succeeded: 0, retried: 0, dead: 0, superseded: 0 });

/**
 * Claims due jobs. SKIP LOCKED lets several workers run safely. A PROCESSING job whose lease expired
 * (the worker died) is claimable again. Each claim increments attempts.
 */
async function claim(db: Queryable, now: Date, limit: number): Promise<ClaimedJob[]> {
  const r = await db.query<{ id: string; index_name: IndexName; object_id: string; attempts: number }>(
    `WITH due AS (
       SELECT id FROM search_sync_jobs
        WHERE (status = 'PENDING' AND next_attempt_at <= $1)
           OR (status = 'PROCESSING' AND locked_until < $1)
        ORDER BY next_attempt_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED)
     UPDATE search_sync_jobs j
        SET status = 'PROCESSING', attempts = j.attempts + 1, locked_until = $3::timestamptz + make_interval(secs => $4::int)
       FROM due WHERE j.id = due.id
     RETURNING j.id, j.index_name, j.object_id, j.attempts`,
    [now.toISOString(), limit, now.toISOString(), LEASE_MS / 1000],
  );
  return r.rows.map((j) => ({ id: j.id, indexName: j.index_name, objectId: j.object_id, attempts: j.attempts }));
}

async function markSucceeded(db: Queryable, jobs: ClaimedJob[], now: Date): Promise<void> {
  // The attempts check makes a late worker (whose lease was taken over) unable to overwrite the newer claim.
  await db.query(
    `UPDATE search_sync_jobs j SET status = 'SUCCEEDED', processed_at = $3, locked_until = NULL, last_error = NULL
       FROM unnest($1::uuid[], $2::int[]) AS c(id, attempts)
      WHERE j.id = c.id AND j.status = 'PROCESSING' AND j.attempts = c.attempts`,
    [jobs.map((j) => j.id), jobs.map((j) => j.attempts), now.toISOString()],
  );
}

/**
 * A failed job goes back to PENDING with backoff, unless a newer PENDING job already covers the object.
 * That job reads the current state anyway, so this one becomes SUPERSEDED rather than colliding with it.
 * After maxAttempts the job is DEAD: it stays for inspection and the next reconcile or reindex fixes it.
 */
async function markFailed(db: Queryable, jobs: ClaimedJob[], code: string, maxAttempts: number, now: Date): Promise<Omit<DrainReport, 'claimed' | 'succeeded'>> {
  const out = { retried: 0, dead: 0, superseded: 0 };
  for (const j of jobs) {
    if (j.attempts >= maxAttempts) {
      await db.query(
        `UPDATE search_sync_jobs SET status = 'DEAD', last_error = $2, locked_until = NULL
          WHERE id = $1 AND status = 'PROCESSING' AND attempts = $3`,
        [j.id, code, j.attempts],
      );
      out.dead++;
      continue;
    }
    const next = new Date(now.getTime() + retryDelayMs(j.attempts)).toISOString();
    const r = await db.query<{ status: string }>(
      `UPDATE search_sync_jobs SET
          status = CASE WHEN EXISTS (SELECT 1 FROM search_sync_jobs n
                                      WHERE n.index_name = search_sync_jobs.index_name
                                        AND n.object_id = search_sync_jobs.object_id AND n.status = 'PENDING')
                        THEN 'SUPERSEDED' ELSE 'PENDING' END,
          next_attempt_at = $2, locked_until = NULL, last_error = $3
        WHERE id = $1 AND status = 'PROCESSING' AND attempts = $4
       RETURNING status`,
      [j.id, next, code, j.attempts],
    );
    if (r.rows[0]?.status === 'SUPERSEDED') out.superseded++;
    else if (r.rows[0]) out.retried++;
  }
  return out;
}

/** Brings the provider in line with the database for these objects: upsert the live ones, remove the rest. */
async function syncObjects(db: Queryable, provider: SearchProvider, index: IndexName, ids: string[]): Promise<void> {
  const current = await loadRecords(db, index, ids);
  const upserts = [...current.values()];
  const removals = ids.filter((id) => !current.has(id));
  if (upserts.length) await provider.saveObjects(index, upserts);
  if (removals.length) await provider.deleteObjects(index, removals);
}

async function processGroup(deps: Required<Pick<SyncDeps, 'maxAttempts'>> & SyncDeps, index: IndexName, jobs: ClaimedJob[]): Promise<DrainReport> {
  const { db, provider, now = () => new Date() } = deps;
  const report = { ...emptyReport(), claimed: jobs.length };
  const ids = [...new Set(jobs.map((j) => j.objectId))];
  // Keep the code short and generic. Provider bodies and credentials are never stored or logged.
  const codeOf = (err: unknown) => (err instanceof SearchProviderError ? err.code : 'INTERNAL');
  try {
    await syncObjects(db, provider, index, ids);
    await markSucceeded(db, jobs, now());
    report.succeeded = jobs.length;
    return report;
  } catch (err) {
    if (ids.length === 1) {
      deps.logger?.warn({ index, code: codeOf(err) }, 'search sync failed; will retry');
      Object.assign(report, await markFailed(db, jobs, codeOf(err), deps.maxAttempts, now()));
      return report;
    }
  }
  // A batch fails as a whole, so one bad object would hold back its neighbours. Retry each object alone:
  // healthy objects finish now, and only the failing one is rescheduled.
  for (const id of ids) {
    const own = jobs.filter((j) => j.objectId === id);
    try {
      await syncObjects(db, provider, index, [id]);
      await markSucceeded(db, own, now());
      report.succeeded += own.length;
    } catch (err) {
      deps.logger?.warn({ index, code: codeOf(err) }, 'search sync failed for one object; will retry');
      const r = await markFailed(db, own, codeOf(err), deps.maxAttempts, now());
      report.retried += r.retried;
      report.dead += r.dead;
      report.superseded += r.superseded;
    }
  }
  return report;
}

/**
 * Processes due jobs with bounded concurrency. Each worker claims a batch, groups it per index, sends one
 * batch request per index, then marks the jobs. Returns when nothing is due.
 */
export async function drainSearchSync(deps: SyncDeps): Promise<DrainReport> {
  const full = {
    maxAttempts: deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    batchSize: deps.batchSize ?? DEFAULT_BATCH,
    concurrency: deps.concurrency ?? DEFAULT_CONCURRENCY,
    now: deps.now ?? (() => new Date()),
  };
  const total = emptyReport();
  const runner = async (): Promise<void> => {
    for (;;) {
      const jobs = await claim(deps.db, full.now(), full.batchSize);
      if (jobs.length === 0) return;
      const byIndex = new Map<IndexName, ClaimedJob[]>();
      for (const j of jobs) byIndex.set(j.indexName, [...(byIndex.get(j.indexName) ?? []), j]);
      for (const [index, group] of byIndex) {
        const r = await processGroup({ ...deps, ...full }, index, group);
        for (const k of Object.keys(total) as (keyof DrainReport)[]) total[k] += r[k];
      }
    }
  };
  await Promise.all(Array.from({ length: full.concurrency }, runner));
  return total;
}

/** Manual re-index: queues every active object in both indexes through the outbox, then drains. */
export async function reindexAll(deps: SyncDeps): Promise<{ queued: number } & DrainReport> {
  const { db } = deps;
  const m = await db.query(
    `INSERT INTO search_sync_jobs (index_name, object_id)
     SELECT $1, id FROM medicines WHERE active
     ON CONFLICT (index_name, object_id) WHERE status = 'PENDING' DO NOTHING`,
    [INDEX_MEDICINES],
  );
  const d = await db.query(
    `INSERT INTO search_sync_jobs (index_name, object_id)
     SELECT $1, d.user_id FROM doctor_profiles d JOIN users u ON u.id = d.user_id WHERE d.active AND u.status = 'ACTIVE'
     ON CONFLICT (index_name, object_id) WHERE status = 'PENDING' DO NOTHING`,
    [INDEX_DOCTORS],
  );
  const drained = await drainSearchSync(deps);
  return { queued: (m.rowCount ?? 0) + (d.rowCount ?? 0), ...drained };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reconciliation: compares what should be indexed (active rows) with what the provider holds. Missing objects
 * and stray objects are queued through the outbox and drained. Nothing is written to the provider directly.
 */
export async function reconcileIndex(deps: SyncDeps, index: IndexName): Promise<{ missing: number; stray: number } & DrainReport> {
  const { db, provider } = deps;
  const desiredSql =
    index === INDEX_MEDICINES
      ? 'SELECT id FROM medicines WHERE active'
      : `SELECT d.user_id AS id FROM doctor_profiles d JOIN users u ON u.id = d.user_id WHERE d.active AND u.status = 'ACTIVE'`;
  const desired = new Set((await db.query<{ id: string }>(desiredSql)).rows.map((r) => r.id));
  const actual = new Set((await provider.listObjectIds(index)).filter((id) => UUID_RE.test(id)));
  const missing = [...desired].filter((id) => !actual.has(id));
  const stray = [...actual].filter((id) => !desired.has(id));
  for (const id of [...missing, ...stray]) await enqueueSync(db, index, id);
  const drained = await drainSearchSync(deps);
  return { missing: missing.length, stray: stray.length, ...drained };
}

/** Operational view for the admin dashboard and the CLI. Counts only: no object payloads. */
export async function syncStatus(db: Queryable): Promise<Record<string, number>> {
  const r = await db.query<{ status: string; n: number }>(`SELECT status, COUNT(*)::int AS n FROM search_sync_jobs GROUP BY status`);
  return Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
}
