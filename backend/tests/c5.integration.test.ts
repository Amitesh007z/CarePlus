import 'dotenv/config';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/common/logger.js';
import { addDays, istDateOf } from '../src/common/time.js';
import type { AuthLimits } from '../src/common/security/rateLimiter.js';
import { createDatabase, type Database } from '../src/infrastructure/database/pool.js';
import { upsertMedicineSeed } from '../src/modules/medicines/catalogue.seed.js';
import { catalogueQuery } from '../src/modules/medicines/catalogue.schemas.js';
import { searchCatalogue, getPublicMedicine } from '../src/modules/medicines/catalogue.service.js';
import { enqueueSync, drainSearchSync, reindexAll, reconcileIndex } from '../src/modules/search/search-sync.js';
import {
  INDEX_MEDICINES,
  SearchProviderError,
  type IndexName,
  type IndexRecord,
  type SearchProvider,
} from '../src/modules/search/search-provider.js';
import { buildApp, testHasher } from './helpers.js';

// Real-database tests against Neon. Each run uses its own synthetic medicines, doctors and patients under the
// test domain below. Issued prescriptions are immutable by design, so those rows remain.
const url = process.env.TEST_DATABASE_URL;
const DOMAIN = '@carepulse-c5.invalid';
const PASSWORD = 'Strong@123';
const roomy: AuthLimits = { windowSec: 900, loginPerIp: 100_000, loginFailuresPerIdentifier: 100, registerPerIp: 100_000 };
const MIN = 60_000;
const logger = createLogger('silent');

const uniq = () => `${Date.now().toString(36)}${randomInt(1e6).toString(36)}`;
const mobile = () => `9${String(randomInt(0, 1e9)).padStart(9, '0')}`;

/** In-memory stand-in for Algolia. Failures are per object (deterministic) or a global outage switch. */
function memoryProvider() {
  const stores: Record<IndexName, Map<string, IndexRecord>> = { carepulse_medicines: new Map(), carepulse_doctors: new Map() };
  const failIds = new Map<string, number>();
  const calls = { search: 0 };
  let down = false;
  const failIfNeeded = (ids: string[]) => {
    if (down) throw new SearchProviderError('TIMEOUT');
    for (const id of ids) {
      const left = failIds.get(id) ?? 0;
      if (left > 0) {
        failIds.set(id, left - 1);
        throw new SearchProviderError('UNAVAILABLE', 503);
      }
    }
  };
  const provider: SearchProvider = {
    async saveObjects(index, records) {
      failIfNeeded(records.map((r) => r.objectID));
      for (const r of records) stores[index].set(r.objectID, r);
    },
    async deleteObjects(index, ids) {
      failIfNeeded(ids);
      for (const id of ids) stores[index].delete(id);
    },
    async searchIds(index, query, limit) {
      calls.search++;
      if (down) throw new SearchProviderError('TIMEOUT');
      const hits = [...stores[index].values()].filter((r) => JSON.stringify(r).toLowerCase().includes(query.toLowerCase()));
      return { ids: hits.slice(0, limit).map((h) => h.objectID), nbHits: hits.length };
    },
    async listObjectIds(index) {
      if (down) throw new SearchProviderError('TIMEOUT');
      return [...stores[index].keys()];
    },
    async configure() {
      /* settings are exercised in the adapter unit tests */
    },
  };
  return {
    provider,
    stores,
    calls,
    failOnce: (id: string, times = 1) => failIds.set(id, times),
    setDown: (v: boolean) => (down = v),
  };
}

interface Who {
  id: string;
  cookie: string;
  csrf: string;
}

describe.skipIf(!url)('C5: catalogue, outbox search sync, pharmacy fulfilment, stock and clinical rules (integration)', () => {
  let db: Database;
  let app: ReturnType<typeof buildApp>;
  let mem: ReturnType<typeof memoryProvider>;
  let admin: Who;
  let pharmacist: Who;
  let doctor: Who;
  const seededIds: Record<string, string> = {};
  let slotSeq = 0;
  const maxAttempts = 3;

  const cookieOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[] | undefined)?.[0]?.split(';')[0] ?? '';
  const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, who?: Who, body?: object) => {
    const agent = request(app);
    const t0 = method === 'get' ? agent.get(path) : method === 'post' ? agent.post(path) : method === 'put' ? agent.put(path) : method === 'patch' ? agent.patch(path) : agent.delete(path);
    const t = who ? t0.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrf) : t0;
    return body !== undefined ? t.send(body) : t;
  };
  async function login(email: string, id: string): Promise<Who> {
    const r = await request(app).post('/api/v1/auth/login').send({ identifier: email, password: PASSWORD });
    return { id, cookie: cookieOf(r), csrf: r.body.data.csrfToken as string };
  }
  async function makeStaff(role: 'ADMIN' | 'PHARMACIST'): Promise<Who> {
    const email = `${role.toLowerCase()}${uniq()}${DOMAIN}`;
    const u = await db.query<{ id: string }>(`INSERT INTO users (role, email, mobile, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`, [role, email, mobile(), await testHasher.hash(PASSWORD)]);
    const id = u.rows[0]!.id;
    const table = role === 'ADMIN' ? 'admin_profiles' : 'pharmacist_profiles';
    await db.query(`INSERT INTO ${table} (user_id, display_name) VALUES ($1, $2)`, [id, `${role} ${uniq()}`]);
    return login(email, id);
  }
  async function makeDoctor(): Promise<Who> {
    const email = `doc${uniq()}${DOMAIN}`;
    const u = await db.query<{ id: string }>(`INSERT INTO users (role, email, mobile, password_hash) VALUES ('DOCTOR', $1, $2, $3) RETURNING id`, [email, mobile(), await testHasher.hash(PASSWORD)]);
    const id = u.rows[0]!.id;
    await db.query(`INSERT INTO doctor_profiles (user_id, display_name, specialty, registration_no, experience_years) VALUES ($1, 'Dr Pharmacy Test', 'General Physician', $2, 9)`, [id, `REG-${uniq()}`]);
    return login(email, id);
  }
  async function makePatient(): Promise<Who> {
    const email = `pat${uniq()}${DOMAIN}`;
    const r = await request(app).post('/api/v1/auth/register').send({
      fullName: 'Fulfil Patient', email, mobile: mobile(), password: PASSWORD, dob: '1990-02-02', gender: 'MALE',
      bloodGroup: 'O+', addressLine: '1 Test Lane', city: 'Pune', state: 'Maharashtra', pincode: '411004',
      emergencyContactName: 'Kin Person', emergencyContactPhone: mobile(), consent: true,
    });
    return { id: r.body.data.user.id as string, cookie: cookieOf(r), csrf: r.body.data.csrfToken as string };
  }

  const newMedicine = (over: Record<string, unknown> = {}) => {
    const u = uniq();
    return {
      sku: `T5${u}`, name: `T5 Medicine ${u}`, strength: '10 mg', form: 'Tablet', category: 'C5 Test', packSize: 'Strip of 10',
      priceInr: 50, rxRequired: false, allergyClass: null, description: 'Synthetic test product', manufacturer: 'Synthetic Labs',
      chronicEligible: false, initialStock: 20, active: true, ...over,
    };
  };
  const drain = (now?: Date) => drainSearchSync({ db, provider: mem.provider, logger, maxAttempts, now: () => now ?? new Date() });
  // Scoped drain: other test files share this database and queue their own jobs.
  const drainOnly = (ids: string[], now: Date) => drainSearchSync({ db, provider: mem.provider, logger, maxAttempts, now: () => now, objectIds: ids });

  async function jobsFor(objectId: string) {
    return (await db.query<{ status: string; attempts: number; last_error: string | null; next_attempt_at: Date }>(
      'SELECT status, attempts, last_error, next_attempt_at FROM search_sync_jobs WHERE object_id = $1 ORDER BY created_at',
      [objectId],
    )).rows;
  }

  /** Books, confirms and finalizes a consultation (through the API). Returns the consultation id. */
  async function finalizedConsultation(pat: Who): Promise<string> {
    slotSeq++;
    const at = new Date(Date.now() + (2 + slotSeq * 0.05) * MIN + 4321);
    const slot = await db.query<{ id: string }>(
      `INSERT INTO appointment_slots (doctor_user_id, starts_at, ends_at) VALUES ($1, $2, $2::timestamptz + interval '30 minutes') RETURNING id`,
      [doctor.id, at.toISOString()],
    );
    const booked = await api('post', '/api/v1/appointments', pat, { slotId: slot.rows[0]!.id, chiefComplaint: 'Cough', symptoms: ['cough'], durationDays: 2, severity: 'MILD' });
    const apptId = booked.body.data.id as string;
    await api('patch', `/api/v1/doctor/appointments/${apptId}/status`, doctor, { status: 'CONFIRMED' });
    const cid = (await api('post', `/api/v1/doctor/appointments/${apptId}/consultation`, doctor)).body.data.id as string;
    await api('put', `/api/v1/doctor/consultations/${cid}`, doctor, { chiefComplaint: 'Cough', examinationNotes: null, diagnosisDescription: 'Test diagnosis', severity: 'MILD', followUpOn: null, vitals: null });
    await api('post', `/api/v1/doctor/consultations/${cid}/finalize`, doctor);
    return cid;
  }

  /** A draft with one line per medicine id, issued. Returns the prescription id and number. */
  async function issuedRx(pat: Who, lines: { medicineId: string; quantity: number }[]): Promise<{ rxId: string; rxNumber: string }> {
    const cid = await finalizedConsultation(pat);
    const rxId = (await api('post', `/api/v1/doctor/consultations/${cid}/prescriptions`, doctor)).body.data.id as string;
    for (const l of lines) {
      const r = await api('post', `/api/v1/doctor/prescriptions/${rxId}/items`, doctor, { medicineId: l.medicineId, dose: '10 mg', frequency: 'Once a day', durationDays: 3, quantity: l.quantity });
      expect(r.status).toBe(201);
    }
    const issued = await api('post', `/api/v1/doctor/prescriptions/${rxId}/issue`, doctor);
    expect(issued.status).toBe(200);
    return { rxId, rxNumber: issued.body.data.rxNumber as string };
  }

  beforeAll(async () => {
    db = createDatabase({ connectionString: url as string, max: 6, logger });
    app = buildApp(db, { limits: roomy });
    mem = memoryProvider();
    await upsertMedicineSeed(db);
    for (const row of (await db.query<{ id: string; sku: string }>('SELECT id, sku FROM medicines')).rows) seededIds[row.sku] = row.id;
    admin = await makeStaff('ADMIN');
    pharmacist = await makeStaff('PHARMACIST');
    doctor = await makeDoctor();
  });

  // ---- Catalogue CRUD and access --------------------------------------------------------------

  it('admin creates, updates and deactivates a medicine; the public view hides inactive rows and exact stock', async () => {
    const body = newMedicine({ name: `T5 Public ${uniq()}`, initialStock: 42 });
    const created = await api('post', '/api/v1/admin/medicines', admin, body);
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect(created.body.data).toMatchObject({ sku: body.sku.toUpperCase(), stockQty: 42, availability: 'IN_STOCK', active: true });

    const pub = await api('get', `/api/v1/catalogue/medicines/${id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data).not.toHaveProperty('stockQty');
    expect(pub.body.data).not.toHaveProperty('active');

    const renamed = await api('patch', `/api/v1/admin/medicines/${id}`, admin, { name: `${body.name} Forte`, priceInr: 75 });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ name: `${body.name} Forte`, priceInr: 75 });

    expect((await api('post', `/api/v1/admin/medicines/${id}/deactivate`, admin)).body.data.active).toBe(false);
    expect((await api('get', `/api/v1/catalogue/medicines/${id}`)).status).toBe(404);
    const listed = await api('get', `/api/v1/catalogue/medicines?q=${encodeURIComponent(body.name.slice(0, 14))}`);
    expect(listed.body.data.items.map((m: { id: string }) => m.id)).not.toContain(id);
    const adminView = await api('get', `/api/v1/admin/medicines?q=${encodeURIComponent(body.name.slice(0, 14))}&active=false`, admin);
    expect(adminView.body.data.items.map((m: { id: string }) => m.id)).toContain(id);
  });

  it('enforces admin-only writes and SKU uniqueness', async () => {
    const body = newMedicine();
    expect((await api('post', '/api/v1/admin/medicines', undefined, body)).status).toBe(401);
    expect((await api('post', '/api/v1/admin/medicines', doctor, body)).status).toBe(403);
    expect((await api('post', '/api/v1/admin/medicines', pharmacist, body)).status).toBe(403);
    expect((await api('post', '/api/v1/admin/medicines', admin, body)).status).toBe(201);
    const dup = await api('post', '/api/v1/admin/medicines', admin, { ...body, name: 'Another name' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_SKU');
    expect((await api('post', '/api/v1/admin/medicines', admin, { ...body, sku: `T5${uniq()}`, price: 0 })).status).toBe(422);
  });

  it('the seeded catalogue matches the brief: eight medicines with their pack sizes, prices and Rx/OTC flags', async () => {
    const rows = (await db.query<{ sku: string; pack_size: string; price_inr: string; rx_required: boolean }>(
      `SELECT sku, pack_size, price_inr, rx_required FROM medicines WHERE sku LIKE 'MED-10%' ORDER BY sku`,
    )).rows;
    expect(rows).toHaveLength(8);
    expect(rows.find((r) => r.sku === 'MED-1002')).toMatchObject({ pack_size: 'Strip of 10', rx_required: true });
    expect(rows.find((r) => r.sku === 'MED-1006')).toMatchObject({ pack_size: 'Strip of 15', rx_required: false });
  });

  // ---- Outbox ---------------------------------------------------------------------------------

  it('the outbox row commits with the catalogue change, and a rollback leaves no job behind', async () => {
    const sku = `T5RB${uniq()}`;
    let rolledBackId = '';
    await expect(
      db.transaction(async (tx) => {
        const r = await tx.query<{ id: string }>(
          `INSERT INTO medicines (sku, name, form, category, pack_size, price_inr, rx_required) VALUES ($1, 'Rollback test', 'Tablet', 'C5 Test', 'Strip of 2', 10, false) RETURNING id`,
          [sku],
        );
        rolledBackId = r.rows[0]!.id;
        await enqueueSync(tx, INDEX_MEDICINES, rolledBackId);
        throw new Error('simulated failure after the job was queued');
      }),
    ).rejects.toThrow('simulated failure');
    expect((await db.query('SELECT 1 FROM medicines WHERE sku = $1', [sku])).rowCount).toBe(0);
    expect(await jobsFor(rolledBackId)).toHaveLength(0);
  });

  it('a successful create queues exactly one job; a duplicate enqueue collapses into it', async () => {
    const created = await api('post', '/api/v1/admin/medicines', admin, newMedicine());
    const id = created.body.data.id as string;
    expect(await jobsFor(id)).toEqual([expect.objectContaining({ status: 'PENDING', attempts: 0 })]);
    await enqueueSync(db, INDEX_MEDICINES, id);
    await enqueueSync(db, INDEX_MEDICINES, id);
    expect(await jobsFor(id)).toHaveLength(1);
  });

  it('stock changes do not queue a search sync, but search-indexed fields do', async () => {
    const id = (await api('post', '/api/v1/admin/medicines', admin, newMedicine())).body.data.id as string;
    await drain(new Date(Date.now() + 3_600_000));
    expect((await jobsFor(id))[0]!.status).toBe('SUCCEEDED');
    const stock = await api('post', `/api/v1/pharmacy/medicines/${id}/stock`, pharmacist, { delta: 5, note: 'Goods received' });
    expect(stock.status).toBe(200);
    expect(await jobsFor(id)).toHaveLength(1);
    await api('patch', `/api/v1/admin/medicines/${id}`, admin, { chronicEligible: true });
    expect(await jobsFor(id)).toHaveLength(1);
    await api('patch', `/api/v1/admin/medicines/${id}`, admin, { packSize: 'Strip of 20' });
    expect(await jobsFor(id)).toHaveLength(2);
  });

  // ---- Indexing, retry, outage, reconcile ---------------------------------------------------------

  it('indexing succeeds with the expected record only: no stock, no internal flags', async () => {
    const id = (await api('post', '/api/v1/admin/medicines', admin, newMedicine({ name: `T5 Indexed ${uniq()}` }))).body.data.id as string;
    const report = await drain(new Date(Date.now() + 3_600_000));
    expect(report.succeeded).toBeGreaterThanOrEqual(1);
    const record = mem.stores.carepulse_medicines.get(id) as unknown as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(
      ['allergyClass', 'category', 'description', 'form', 'manufacturer', 'name', 'objectID', 'packSize', 'priceInr', 'rxRequired', 'sku', 'strength'].sort(),
    );
    expect(record.objectID).toBe(id);
  });

  it('retry succeeds: a failed batch is rescheduled with backoff and then indexed', async () => {
    const id = (await api('post', '/api/v1/admin/medicines', admin, newMedicine())).body.data.id as string;
    mem.failOnce(id, 1);
    // Clock skew: the database stamps due times, so the first drain gets a margin.
    const now = new Date(Date.now() + 120_000);
    await drainOnly([id], now);
    const [job] = await jobsFor(id);
    expect(job).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'UNAVAILABLE_503' });
    expect(job!.next_attempt_at.getTime()).toBeGreaterThan(now.getTime());
    expect(mem.stores.carepulse_medicines.has(id)).toBe(false);
    await drainOnly([id], new Date(now.getTime() + 3_600_000));
    expect((await jobsFor(id))[0]).toMatchObject({ status: 'SUCCEEDED', last_error: null });
    expect(mem.stores.carepulse_medicines.has(id)).toBe(true);
  });

  it('one failing object does not hold back healthy objects queued in the same batch', async () => {
    const bad = (await api('post', '/api/v1/admin/medicines', admin, newMedicine())).body.data.id as string;
    const good = (await api('post', '/api/v1/admin/medicines', admin, newMedicine())).body.data.id as string;
    // The bad object keeps failing for this drain, whether it is sent in a batch or alone. The invariant under test:
    // healthy neighbours still finish, and the bad one is rescheduled rather than lost.
    mem.failOnce(bad, 99);
    // Clock skew: the database stamps due times, so the first drain gets a margin.
    const now = new Date(Date.now() + 120_000);
    await drainOnly([bad, good], now);
    expect(mem.stores.carepulse_medicines.has(good)).toBe(true);
    expect((await jobsFor(good))[0]!.status).toBe('SUCCEEDED');
    expect((await jobsFor(bad))[0]).toMatchObject({ status: 'PENDING' });
    expect((await jobsFor(bad))[0]!.attempts).toBeGreaterThanOrEqual(1);
    mem.failOnce(bad, 0); // the outage clears
    await drainOnly([bad, good], new Date(now.getTime() + 3_600_000));
    expect(mem.stores.carepulse_medicines.has(bad)).toBe(true);
  });

  it('jobs that keep failing become DEAD after the bounded number of attempts', async () => {
    const id = (await api('post', '/api/v1/admin/medicines', admin, newMedicine())).body.data.id as string;
    mem.failOnce(id, 99);
    // Each round moves the clock past the previous backoff, so the job is due again.
    for (let i = 0; i < maxAttempts; i++) await drain(new Date(Date.now() + (i + 1) * 24 * 3_600_000));
    expect((await jobsFor(id))[0]).toMatchObject({ status: 'DEAD', attempts: maxAttempts, last_error: 'UNAVAILABLE_503' });
    expect(mem.stores.carepulse_medicines.has(id)).toBe(false);
  });

  it('an Algolia outage does not lose a database update; the job waits and indexes once the provider recovers', async () => {
    const id = (await api('post', '/api/v1/admin/medicines', admin, newMedicine({ name: `T5 Outage ${uniq()}` }))).body.data.id as string;
    await drain(new Date(Date.now() + 3_600_000));
    mem.setDown(true);
    try {
      const renamed = await api('patch', `/api/v1/admin/medicines/${id}`, admin, { name: 'T5 Outage Renamed' });
      expect(renamed.status).toBe(200);
      expect((await api('get', `/api/v1/catalogue/medicines/${id}`)).body.data.name).toBe('T5 Outage Renamed');
      const report = await drain(new Date(Date.now() + 3_600_000));
      expect(report.retried + report.superseded).toBeGreaterThanOrEqual(1);
      expect((await jobsFor(id)).at(-1)!.status).toMatch(/PENDING|SUPERSEDED/);
    } finally {
      mem.setDown(false);
    }
    await drain(new Date(Date.now() + 7 * 3_600_000));
    expect(mem.stores.carepulse_medicines.get(id)).toMatchObject({ name: 'T5 Outage Renamed' });
  });

  it('deactivation removes the object from the index', async () => {
    const id = (await api('post', '/api/v1/admin/medicines', admin, newMedicine())).body.data.id as string;
    await drain(new Date(Date.now() + 3_600_000));
    expect(mem.stores.carepulse_medicines.has(id)).toBe(true);
    await api('post', `/api/v1/admin/medicines/${id}/deactivate`, admin);
    await drain(new Date(Date.now() + 7 * 3_600_000));
    expect(mem.stores.carepulse_medicines.has(id)).toBe(false);
  });

  it('re-index queues every active medicine and doctor, and drains them into the index', async () => {
    const report = await reindexAll({ db, provider: mem.provider, logger, maxAttempts, now: () => new Date(Date.now() + 14 * 3_600_000) });
    expect(report.queued).toBeGreaterThanOrEqual(8);
    expect(mem.stores.carepulse_medicines.has(seededIds['MED-1001']!)).toBe(true);
    expect(mem.stores.carepulse_doctors.has(doctor.id)).toBe(true);
  });

  it('reconciliation repairs a missing object and removes a stray one', async () => {
    const missingId = seededIds['MED-1005']!;
    const stray = '6f1c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6';
    mem.stores.carepulse_medicines.delete(missingId);
    mem.stores.carepulse_medicines.set(stray, { objectID: stray, sku: 'X', name: 'Stray', strength: null, form: 'x', category: 'x', packSize: 'x', priceInr: 1, rxRequired: false, allergyClass: null, description: null, manufacturer: null });
    const r = await reconcileIndex({ db, provider: mem.provider, logger, maxAttempts, now: () => new Date(Date.now() + 30 * 3_600_000) }, INDEX_MEDICINES);
    expect(r.missing).toBeGreaterThanOrEqual(1);
    expect(r.stray).toBeGreaterThanOrEqual(1);
    expect(mem.stores.carepulse_medicines.has(missingId)).toBe(true);
    expect(mem.stores.carepulse_medicines.has(stray)).toBe(false);
  });

  it('doctor directory indexing sends only public directory fields', async () => {
    await reindexAll({ db, provider: mem.provider, logger, maxAttempts, now: () => new Date(Date.now() + 40 * 3_600_000) });
    const rec = mem.stores.carepulse_doctors.get(doctor.id) as unknown as Record<string, unknown>;
    expect(Object.keys(rec).sort()).toEqual(['displayName', 'experienceYears', 'objectID', 'specialty']);
    expect(JSON.stringify(rec)).not.toMatch(/REG-|@carepulse|mobile/);
  });

  // ---- Search and filters ----------------------------------------------------------------------

  it('search ranks through the index but PostgreSQL filters, sorts and paginates; the provider decides only order', async () => {
    const tag = `Zq${uniq()}`;
    const cheap = (await api('post', '/api/v1/admin/medicines', admin, newMedicine({ name: `${tag} Cheap`, priceInr: 20, rxRequired: true, category: 'C5 Search' }))).body.data.id as string;
    const dear = (await api('post', '/api/v1/admin/medicines', admin, newMedicine({ name: `${tag} Dear`, priceInr: 90, rxRequired: false, category: 'C5 Search' }))).body.data.id as string;
    await drain(new Date(Date.now() + 3_600_000));

    const q = (raw: Record<string, string>) => catalogueQuery.parse({ q: tag, ...raw });
    const all = await searchCatalogue(db, mem.provider, q({ sort: 'price_asc' }));
    expect(all.engine).toBe('algolia');
    expect(all.degraded).toBe(false);
    expect(all.items.map((m) => m.id)).toEqual([cheap, dear]);
    expect((await searchCatalogue(db, mem.provider, q({ sort: 'price_desc' }))).items[0]!.id).toBe(dear);
    expect((await searchCatalogue(db, mem.provider, q({ rx: 'rx' }))).items.map((m) => m.id)).toEqual([cheap]);
    expect((await searchCatalogue(db, mem.provider, q({ rx: 'otc' }))).items.map((m) => m.id)).toEqual([dear]);
    expect((await searchCatalogue(db, mem.provider, q({ minPrice: '50' }))).items.map((m) => m.id)).toEqual([dear]);
    expect((await searchCatalogue(db, mem.provider, q({ category: 'C5 Search' }))).meta.total).toBe(2);
    const page = await searchCatalogue(db, mem.provider, q({ sort: 'price_asc', pageSize: '1', page: '2' }));
    expect(page.items.map((m) => m.id)).toEqual([dear]);
    expect(page.meta).toMatchObject({ total: 2, totalPages: 2 });
  });

  it('a stale index entry for a deactivated medicine never reaches the results', async () => {
    const tag = `Zs${uniq()}`;
    const id = (await api('post', '/api/v1/admin/medicines', admin, newMedicine({ name: `${tag} Gone` }))).body.data.id as string;
    await drain(new Date(Date.now() + 3_600_000));
    await db.query('UPDATE medicines SET active = false WHERE id = $1', [id]);
    const out = await searchCatalogue(db, mem.provider, catalogueQuery.parse({ q: tag }));
    expect(out.items).toEqual([]);
  });

  it('when the provider fails the search degrades to PostgreSQL and says so; stock-only filtering skips the provider', async () => {
    const tag = `Zd${uniq()}`;
    await api('post', '/api/v1/admin/medicines', admin, newMedicine({ name: `${tag} Fallback` }));
    mem.setDown(true);
    try {
      const degraded = await searchCatalogue(db, mem.provider, catalogueQuery.parse({ q: tag }));
      expect(degraded).toMatchObject({ engine: 'postgres', degraded: true });
      expect(degraded.items).toHaveLength(1);
      const before = mem.calls.search;
      const inStock = await searchCatalogue(db, mem.provider, catalogueQuery.parse({ q: tag, inStock: 'true' }));
      expect(inStock).toMatchObject({ engine: 'postgres', degraded: false });
      expect(mem.calls.search).toBe(before);
    } finally {
      mem.setDown(false);
    }
    expect((await getPublicMedicine(db, seededIds['MED-1006']!)).availability).toBe('IN_STOCK');
  });

  it('the HTTP search endpoint serves results with no provider configured, from PostgreSQL', async () => {
    const tag = `Zh${uniq()}`;
    await api('post', '/api/v1/admin/medicines', admin, newMedicine({ name: `${tag} Plain` }));
    const res = await api('get', `/api/v1/catalogue/search?q=${tag}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ engine: 'postgres', degraded: false });
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).not.toHaveProperty('stockQty');
  });

  // ---- Stock ledger ----------------------------------------------------------------------------

  it('stock adjustments keep a ledger and can never go below zero; the ledger is append-only', async () => {
    const id = (await api('post', '/api/v1/admin/medicines', admin, newMedicine({ initialStock: 3 }))).body.data.id as string;
    const down = await api('post', `/api/v1/pharmacy/medicines/${id}/stock`, pharmacist, { delta: -5, note: 'Count correction' });
    expect(down.status).toBe(409);
    expect(down.body.error.code).toBe('INSUFFICIENT_STOCK');
    const up = await api('post', `/api/v1/pharmacy/medicines/${id}/stock`, pharmacist, { delta: 7, note: 'Goods received' });
    // 10 units is at the low-stock threshold, which is inclusive.
    expect(up.body.data).toMatchObject({ stockOnHand: 10, availability: 'LOW_STOCK' });
    const moves = await api('get', `/api/v1/pharmacy/medicines/${id}/movements`, pharmacist);
    expect(moves.body.data.items.map((m: { balanceAfter: number }) => m.balanceAfter)).toEqual([10, 3]);
    await expect(db.query('UPDATE stock_movements SET delta = 0 WHERE medicine_id = $1', [id])).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM stock_movements WHERE medicine_id = $1', [id])).rejects.toThrow(/append-only/);
  });

  // ---- Pharmacy fulfilment ---------------------------------------------------------------------

  it('fulfilment runs end to end: send, verify, pack (stock out, prescription fulfilled), dispatch, deliver', async () => {
    const medId = (await api('post', '/api/v1/admin/medicines', admin, newMedicine({ initialStock: 10 }))).body.data.id as string;
    const pat = await makePatient();
    const { rxId, rxNumber } = await issuedRx(pat, [{ medicineId: medId, quantity: 2 }]);

    const sent = await api('post', `/api/v1/patients/me/prescriptions/${rxId}/fulfilment`, pat);
    expect(sent.status).toBe(201);
    expect((await api('post', `/api/v1/patients/me/prescriptions/${rxId}/fulfilment`, pat)).body.error.code).toBe('ALREADY_QUEUED');
    expect((await api('get', `/api/v1/patients/me/prescriptions/${rxId}/fulfilment`, pat)).body.data.fulfilment.status).toBe('QUEUED');

    const fid = sent.body.data.id as string;
    const queue = await api('get', '/api/v1/pharmacy/fulfilments?view=queue', pharmacist);
    expect(queue.body.data.items.map((i: { id: string }) => i.id)).toContain(fid);
    const detail = await api('get', `/api/v1/pharmacy/fulfilments/${fid}`, pharmacist);
    expect(detail.body.data).toMatchObject({ status: 'QUEUED', canPack: true, prescription: { rxNumber } });
    expect(detail.body.data.prescription.patient).not.toHaveProperty('mobile');

    expect((await api('post', `/api/v1/pharmacy/fulfilments/${fid}/actions`, pharmacist, { action: 'pack' })).body.error.code).toBe('INVALID_TRANSITION');
    expect((await api('post', `/api/v1/pharmacy/fulfilments/${fid}/actions`, pharmacist, { action: 'verify' })).body.data.status).toBe('VERIFIED');
    expect((await api('post', `/api/v1/pharmacy/fulfilments/${fid}/actions`, pharmacist, { action: 'pack' })).body.data.status).toBe('PACKED');

    const after = await db.query<{ stock_qty: number }>('SELECT stock_qty FROM medicines WHERE id = $1', [medId]);
    expect(after.rows[0]!.stock_qty).toBe(8);
    const movement = await db.query<{ delta: number; balance_after: number; reason: string }>(
      `SELECT delta, balance_after, reason FROM stock_movements WHERE medicine_id = $1 AND reason = 'DISPENSE'`,
      [medId],
    );
    expect(movement.rows).toEqual([{ delta: -2, balance_after: 8, reason: 'DISPENSE' }]);
    const rx = await db.query<{ status: string; fulfilled_at: Date | null }>('SELECT status, fulfilled_at FROM prescriptions WHERE id = $1', [rxId]);
    expect(rx.rows[0]).toMatchObject({ status: 'FULFILLED' });

    expect((await api('post', `/api/v1/pharmacy/fulfilments/${fid}/actions`, pharmacist, { action: 'dispatch' })).body.data.status).toBe('OUT_FOR_DELIVERY');
    expect((await api('post', `/api/v1/pharmacy/fulfilments/${fid}/actions`, pharmacist, { action: 'deliver' })).body.data.status).toBe('DELIVERED');
    expect((await api('get', `/api/v1/patients/me/prescriptions/${rxId}/fulfilment`, pat)).body.data.fulfilment).toMatchObject({ status: 'DELIVERED' });
    expect((await api('post', `/api/v1/patients/me/prescriptions/${rxId}/fulfilment`, pat)).status).toBe(409);
  });

  it('insufficient stock aborts packing entirely: prescription and request stay as they were', async () => {
    const medId = (await api('post', '/api/v1/admin/medicines', admin, newMedicine({ initialStock: 1 }))).body.data.id as string;
    const pat = await makePatient();
    const { rxId } = await issuedRx(pat, [{ medicineId: medId, quantity: 2 }]);
    const fid = (await api('post', `/api/v1/patients/me/prescriptions/${rxId}/fulfilment`, pat)).body.data.id as string;
    await api('post', `/api/v1/pharmacy/fulfilments/${fid}/actions`, pharmacist, { action: 'verify' });

    const blocked = await api('post', `/api/v1/pharmacy/fulfilments/${fid}/actions`, pharmacist, { action: 'pack' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await db.query<{ status: string }>('SELECT status FROM prescriptions WHERE id = $1', [rxId])).rows[0]!.status).toBe('ISSUED');
    expect((await db.query<{ status: string }>('SELECT status FROM fulfilments WHERE id = $1', [fid])).rows[0]!.status).toBe('VERIFIED');
    expect((await db.query('SELECT 1 FROM stock_movements WHERE fulfilment_id = $1', [fid])).rowCount).toBe(0);

    await api('post', `/api/v1/pharmacy/medicines/${medId}/stock`, pharmacist, { delta: 5, note: 'Delivery received' });
    expect((await api('post', `/api/v1/pharmacy/fulfilments/${fid}/actions`, pharmacist, { action: 'pack' })).body.data.status).toBe('PACKED');
  });

  it('rejection needs a reason, ends the request, and lets the patient re-send', async () => {
    const medId = (await api('post', '/api/v1/admin/medicines', admin, newMedicine())).body.data.id as string;
    const pat = await makePatient();
    const { rxId } = await issuedRx(pat, [{ medicineId: medId, quantity: 1 }]);
    const fid = (await api('post', `/api/v1/patients/me/prescriptions/${rxId}/fulfilment`, pat)).body.data.id as string;
    expect((await api('post', `/api/v1/pharmacy/fulfilments/${fid}/actions`, pharmacist, { action: 'reject' })).status).toBe(422);
    const rejected = await api('post', `/api/v1/pharmacy/fulfilments/${fid}/actions`, pharmacist, { action: 'reject', reason: 'Dosage unclear' });
    expect(rejected.body.data).toMatchObject({ status: 'REJECTED', rejectionReason: 'Dosage unclear' });
    expect((await api('post', `/api/v1/pharmacy/fulfilments/${fid}/actions`, pharmacist, { action: 'verify' })).body.error.code).toBe('INVALID_TRANSITION');
    expect((await api('get', `/api/v1/patients/me/prescriptions/${rxId}/fulfilment`, pat)).body.data.fulfilment).toMatchObject({ status: 'REJECTED', rejectionReason: 'Dosage unclear' });
    const again = await api('post', `/api/v1/patients/me/prescriptions/${rxId}/fulfilment`, pat);
    expect(again.status).toBe(201);
  });

  it('a patient cannot send another patient’s prescription, and pharmacists cannot reach patient or doctor routes', async () => {
    const medId = (await api('post', '/api/v1/admin/medicines', admin, newMedicine())).body.data.id as string;
    const owner = await makePatient();
    const other = await makePatient();
    const { rxId } = await issuedRx(owner, [{ medicineId: medId, quantity: 1 }]);
    expect((await api('post', `/api/v1/patients/me/prescriptions/${rxId}/fulfilment`, other)).status).toBe(404);
    expect((await api('get', `/api/v1/patients/me/prescriptions/${rxId}/fulfilment`, other)).body.data.fulfilment).toBeNull();
    expect((await api('get', '/api/v1/pharmacy/fulfilments', doctor)).status).toBe(403);
    expect((await api('post', `/api/v1/patients/me/prescriptions/${rxId}/fulfilment`, pharmacist)).status).toBe(403);
  });

  // ---- Clinical rules: interactions and chronic validity --------------------------------------

  it('a MAJOR interaction blocks issuing; MODERATE is shown as a warning only', async () => {
    const a = (await api('post', '/api/v1/admin/medicines', admin, newMedicine())).body.data.id as string;
    const b = (await api('post', '/api/v1/admin/medicines', admin, newMedicine())).body.data.id as string;
    const c = (await api('post', '/api/v1/admin/medicines', admin, newMedicine())).body.data.id as string;
    const major = await api('post', '/api/v1/admin/drug-interactions', admin, { medicineAId: a, medicineBId: b, severity: 'MAJOR', effect: 'Test pair: major effect', sourceReference: 'Synthetic test rule' });
    expect(major.status).toBe(201);
    expect((await api('post', '/api/v1/admin/drug-interactions', admin, { medicineAId: b, medicineBId: a, severity: 'MAJOR', effect: 'Duplicate pair', sourceReference: 'Synthetic' })).status).toBe(409);
    expect((await api('post', '/api/v1/admin/drug-interactions', doctor, { medicineAId: a, medicineBId: c, severity: 'MINOR', effect: 'Not allowed', sourceReference: 'x' })).status).toBe(403);

    const pat = await makePatient();
    const cid = await finalizedConsultation(pat);
    const rxId = (await api('post', `/api/v1/doctor/consultations/${cid}/prescriptions`, doctor)).body.data.id as string;
    await api('post', `/api/v1/doctor/prescriptions/${rxId}/items`, doctor, { medicineId: a, dose: '1', frequency: 'Once', durationDays: 1, quantity: 1 });
    await api('post', `/api/v1/doctor/prescriptions/${rxId}/items`, doctor, { medicineId: c, dose: '1', frequency: 'Once', durationDays: 1, quantity: 1 });
    expect((await api('get', `/api/v1/doctor/prescriptions/${rxId}`, doctor)).body.data.checks).toMatchObject({ canIssue: true, interactions: [] });

    await api('post', `/api/v1/doctor/prescriptions/${rxId}/items`, doctor, { medicineId: b, dose: '1', frequency: 'Once', durationDays: 1, quantity: 1 });
    const draft = await api('get', `/api/v1/doctor/prescriptions/${rxId}`, doctor);
    expect(draft.body.data.checks.interactions).toEqual([expect.objectContaining({ severity: 'MAJOR', sourceReference: 'Synthetic test rule' })]);
    expect(draft.body.data.checks.canIssue).toBe(false);
    const blocked = await api('post', `/api/v1/doctor/prescriptions/${rxId}/issue`, doctor);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('INTERACTION_BLOCKED');
    expect((await db.query<{ status: string }>('SELECT status FROM prescriptions WHERE id = $1', [rxId])).rows[0]!.status).toBe('DRAFT');
  });

  it('90-day validity is refused until every medicine is admin-marked chronic-eligible, then issues for 90 days', async () => {
    const med = (await api('post', '/api/v1/admin/medicines', admin, newMedicine())).body.data.id as string;
    const pat = await makePatient();
    const cid = await finalizedConsultation(pat);
    const rxId = (await api('post', `/api/v1/doctor/consultations/${cid}/prescriptions`, doctor)).body.data.id as string;
    await api('post', `/api/v1/doctor/prescriptions/${rxId}/items`, doctor, { medicineId: med, dose: '1', frequency: 'Once', durationDays: 90, quantity: 1 });
    const refused = await api('patch', `/api/v1/doctor/prescriptions/${rxId}`, doctor, { validityDays: 90 });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('NOT_CHRONIC_ELIGIBLE');

    expect((await api('patch', `/api/v1/admin/medicines/${med}`, admin, { chronicEligible: true })).status).toBe(200);
    expect((await api('patch', `/api/v1/doctor/prescriptions/${rxId}`, doctor, { validityDays: 90 })).body.data.validityDays).toBe(90);
    const issued = await api('post', `/api/v1/doctor/prescriptions/${rxId}/issue`, doctor);
    expect(issued.status).toBe(200);
    expect(issued.body.data.validityDays).toBe(90);
    const issuedDay = istDateOf(new Date(issued.body.data.issuedAt));
    expect(issued.body.data.validTill).toBe(addDays(issuedDay, 90));
  });

  it('admin-only tools: the search status endpoint reports configuration and job counts, not payloads', async () => {
    const status = await api('get', '/api/v1/admin/search/status', admin);
    expect(status.status).toBe(200);
    expect(status.body.data).toEqual({ configured: expect.any(Boolean), jobs: expect.any(Object) });
    expect(await api('get', '/api/v1/admin/search/status', doctor)).toMatchObject({ status: 403 });
  });
});
