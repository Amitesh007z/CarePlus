import 'dotenv/config';
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/common/logger.js';
import type { AuthLimits } from '../src/common/security/rateLimiter.js';
import { createDatabase, type Database } from '../src/infrastructure/database/pool.js';
import { upsertMedicineSeed } from '../src/modules/medicines/catalogue.seed.js';
import { transitionOrder } from '../src/modules/commerce/orders.service.js';
import { buildApp, testHasher } from './helpers.js';

// C7 pharmacist console tests against Neon, through the HTTP app. Synthetic data under the test domain.
const url = process.env.TEST_DATABASE_URL;
const DOMAIN = '@carepulse-c7.invalid';
const PASSWORD = 'Strong@123';
const roomy: AuthLimits = { windowSec: 900, loginPerIp: 100_000, loginFailuresPerIdentifier: 100, registerPerIp: 100_000 };
const MIN = 60_000;
const logger = createLogger('silent');
const uniq = () => `${Date.now().toString(36)}${randomInt(1e6).toString(36)}`;
const mobile = () => `9${String(randomInt(0, 1e9)).padStart(9, '0')}`;
const ADDRESS = { label: 'Home', line: '5 Pharmacy Test Road', city: 'Chennai', state: 'Tamil Nadu', pincode: '600028' };
const idemKey = () => `k-${randomUUID()}`;

interface Who {
  id: string;
  cookie: string;
  csrf: string;
}

describe.skipIf(!url)('C7: pharmacist console, prescription verification, fulfilment, inventory and access (integration)', () => {
  let db: Database;
  let app: ReturnType<typeof buildApp>;
  let admin: Who;
  let pharmacist: Who;
  let doctor: Who;
  let slotSeq = 0;

  const cookieOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[] | undefined)?.[0]?.split(';')[0] ?? '';
  const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, who?: Who, body?: object, headers: Record<string, string> = {}) => {
    const agent = request(app);
    let t = method === 'get' ? agent.get(path) : method === 'post' ? agent.post(path) : method === 'put' ? agent.put(path) : method === 'patch' ? agent.patch(path) : agent.delete(path);
    if (who) t = t.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrf);
    for (const [k, v] of Object.entries(headers)) t = t.set(k, v);
    return body !== undefined ? t.send(body) : t;
  };
  async function login(email: string, id: string): Promise<Who> {
    const r = await request(app).post('/api/v1/auth/login').send({ identifier: email, password: PASSWORD });
    return { id, cookie: cookieOf(r), csrf: r.body.data.csrfToken as string };
  }
  async function makeStaff(role: 'ADMIN' | 'PHARMACIST'): Promise<Who> {
    const email = `${role.toLowerCase()}${uniq()}${DOMAIN}`;
    const u = await db.query<{ id: string }>(`INSERT INTO users (role, email, mobile, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`, [role, email, mobile(), await testHasher.hash(PASSWORD)]);
    await db.query(`INSERT INTO ${role === 'ADMIN' ? 'admin_profiles' : 'pharmacist_profiles'} (user_id, display_name) VALUES ($1, 'Staff')`, [u.rows[0]!.id]);
    return login(email, u.rows[0]!.id);
  }
  async function makeDoctor(): Promise<Who> {
    const email = `doc${uniq()}${DOMAIN}`;
    const u = await db.query<{ id: string }>(`INSERT INTO users (role, email, mobile, password_hash) VALUES ('DOCTOR', $1, $2, $3) RETURNING id`, [email, mobile(), await testHasher.hash(PASSWORD)]);
    await db.query(`INSERT INTO doctor_profiles (user_id, display_name, specialty, registration_no, experience_years) VALUES ($1, 'Dr Console', 'General Physician', $2, 6)`, [u.rows[0]!.id, `REG-${uniq()}`]);
    return login(email, u.rows[0]!.id);
  }
  async function makePatient(): Promise<Who> {
    const email = `pat${uniq()}${DOMAIN}`;
    const r = await request(app).post('/api/v1/auth/register').send({
      fullName: 'Console Patient', email, mobile: mobile(), password: PASSWORD, dob: '1984-04-04', gender: 'MALE',
      bloodGroup: 'A-', addressLine: '2 Profile Lane', city: 'Chennai', state: 'Tamil Nadu', pincode: '600028',
      emergencyContactName: 'Kin', emergencyContactPhone: mobile(), consent: true,
    });
    const who = { id: r.body.data.user.id as string, cookie: cookieOf(r), csrf: r.body.data.csrfToken as string };
    expect((await api('post', '/api/v1/patients/me/addresses', who, ADDRESS)).status).toBe(201);
    return who;
  }
  const newMedicine = (over: Record<string, unknown> = {}) => {
    const u = uniq();
    return { sku: `T7${u}`, name: `T7 Console ${u}`, strength: '10 mg', form: 'Tablet', category: 'C7 Test', packSize: 'Strip of 10', priceInr: 60, rxRequired: false, allergyClass: null, description: null, manufacturer: null, chronicEligible: false, initialStock: 30, active: true, ...over };
  };
  async function medicine(over: Record<string, unknown> = {}): Promise<string> {
    const r = await api('post', '/api/v1/admin/medicines', admin, newMedicine(over));
    expect(r.status).toBe(201);
    return r.body.data.id as string;
  }
  const stockOf = async (id: string) => (await db.query<{ stock_qty: number }>('SELECT stock_qty FROM medicines WHERE id = $1', [id])).rows[0]!.stock_qty;

  async function finalizedConsultation(pat: Who): Promise<string> {
    slotSeq++;
    const at = new Date(Date.now() + (2 + slotSeq * 0.05) * MIN + 999);
    const slot = await db.query<{ id: string }>(`INSERT INTO appointment_slots (doctor_user_id, starts_at, ends_at) VALUES ($1, $2, $2::timestamptz + interval '30 minutes') RETURNING id`, [doctor.id, at.toISOString()]);
    const booked = await api('post', '/api/v1/appointments', pat, { slotId: slot.rows[0]!.id, chiefComplaint: 'Cough', symptoms: ['cough'], durationDays: 2, severity: 'MILD' });
    const apptId = booked.body.data.id as string;
    await api('patch', `/api/v1/doctor/appointments/${apptId}/status`, doctor, { status: 'CONFIRMED' });
    const cid = (await api('post', `/api/v1/doctor/appointments/${apptId}/consultation`, doctor)).body.data.id as string;
    await api('put', `/api/v1/doctor/consultations/${cid}`, doctor, { chiefComplaint: 'Cough', examinationNotes: null, diagnosisDescription: 'Confidential diagnosis text', severity: 'MILD', followUpOn: null, vitals: null });
    await api('post', `/api/v1/doctor/consultations/${cid}/finalize`, doctor);
    return cid;
  }
  /** An issued prescription (not yet bought). */
  async function issuedRx(pat: Who, lines: { medicineId: string; quantity: number }[]): Promise<string> {
    const cid = await finalizedConsultation(pat);
    const rxId = (await api('post', `/api/v1/doctor/consultations/${cid}/prescriptions`, doctor)).body.data.id as string;
    for (const l of lines) {
      expect((await api('post', `/api/v1/doctor/prescriptions/${rxId}/items`, doctor, { medicineId: l.medicineId, dose: '10 mg', frequency: 'Once', durationDays: 3, quantity: l.quantity })).status).toBe(201);
    }
    expect((await api('post', `/api/v1/doctor/prescriptions/${rxId}/issue`, doctor)).status).toBe(200);
    return rxId;
  }
  /** Places an OTC order for the patient with one OTC medicine. Returns the order id. */
  async function otcOrder(pat: Who): Promise<string> {
    const otc = await medicine({ priceInr: 45, initialStock: 20 });
    await api('post', '/api/v1/patients/me/cart/items', pat, { medicineId: otc, quantity: 1 });
    const addr = (await db.query<{ id: string }>('SELECT id FROM patient_addresses WHERE patient_user_id = $1 AND is_default', [pat.id])).rows[0]!.id;
    const r = await api('post', '/api/v1/patients/me/orders', pat, { addressId: addr, paymentMethod: 'COD' }, { 'Idempotency-Key': idemKey() });
    expect(r.status).toBe(201);
    return r.body.data.id as string;
  }
  /**
   * Adds a prescription line to a placed order directly in the database. Checkout never produces this on its own;
   * the test uses it to model a bad or tampered line and confirm that verification catches it.
   */
  async function injectRxLine(orderId: string, medicineId: string, rxId: string, quantity: number): Promise<void> {
    const m = (await db.query<{ sku: string; name: string; strength: string | null; pack_size: string; rx_required: boolean; price_inr: string }>(
      'SELECT sku, name, strength, pack_size, rx_required, price_inr FROM medicines WHERE id = $1', [medicineId])).rows[0]!;
    const n = (await db.query<{ n: number }>('SELECT (COALESCE(MAX(line_no), 0) + 1)::int AS n FROM order_items WHERE order_id = $1', [orderId])).rows[0]!.n;
    const unit = Number(m.price_inr);
    await db.query(
      `INSERT INTO order_items (order_id, line_no, medicine_id, sku_snapshot, name_snapshot, strength_snapshot, pack_size_snapshot,
          rx_required_snapshot, unit_price_inr, quantity, line_total_inr, prescription_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [orderId, n, medicineId, m.sku, m.name, m.strength, m.pack_size, m.rx_required, unit, quantity, Number((unit * quantity).toFixed(2)), rxId],
    );
  }
  const act = (who: Who, id: string, action: string, reason?: string) =>
    api('post', `/api/v1/pharmacy/orders/${id}/actions`, who, reason === undefined ? { action } : { action, reason });

  beforeAll(async () => {
    db = createDatabase({ connectionString: url as string, max: 6, logger });
    app = buildApp(db, { limits: roomy });
    await upsertMedicineSeed(db);
    admin = await makeStaff('ADMIN');
    pharmacist = await makeStaff('PHARMACIST');
    doctor = await makeDoctor();
  });

  // ---- Verification ----------------------------------------------------------------------------

  it('a valid prescription order is verified: the check is recorded as PASSED per prescription', async () => {
    const p = await makePatient();
    const med = await medicine({ rxRequired: true, initialStock: 10 });
    const rx = await issuedRx(p, [{ medicineId: med, quantity: 2 }]);
    await api('post', `/api/v1/patients/me/cart/prescriptions/${rx}`, p);
    const id = (await api('post', '/api/v1/patients/me/orders', p, { addressId: (await db.query<{ id: string }>('SELECT id FROM patient_addresses WHERE patient_user_id = $1', [p.id])).rows[0]!.id, paymentMethod: 'COD' }, { 'Idempotency-Key': idemKey() })).body.data.id as string;
    const v = await act(pharmacist, id, 'verify');
    expect(v.status).toBe(200);
    expect(v.body.data.status).toBe('VERIFIED');
    const rec = await db.query<{ result: string; verifier_user_id: string }>('SELECT result, verifier_user_id FROM prescription_verifications WHERE order_id = $1', [id]);
    expect(rec.rows).toEqual([{ result: 'PASSED', verifier_user_id: pharmacist.id }]);
  });

  it('OTC-only orders bypass prescription verification entirely', async () => {
    const p = await makePatient();
    const id = await otcOrder(p);
    const v = await act(pharmacist, id, 'verify');
    expect(v.body.data.status).toBe('VERIFIED');
    expect((await db.query('SELECT 1 FROM prescription_verifications WHERE order_id = $1', [id])).rowCount).toBe(0);
  });

  it('a prescription that belongs to another patient is rejected at verification', async () => {
    const owner = await makePatient();
    const buyer = await makePatient();
    const med = await medicine({ rxRequired: true });
    const rx = await issuedRx(owner, [{ medicineId: med, quantity: 1 }]);
    const id = await otcOrder(buyer);
    await injectRxLine(id, med, rx, 1);
    const r = await act(pharmacist, id, 'verify');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('PRESCRIPTION_OWNER_MISMATCH');
    expect((await db.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [id])).rows[0]!.status).toBe('PLACED');
  });

  it('an expired prescription is rejected at verification (checked with a later clock)', async () => {
    const p = await makePatient();
    const med = await medicine({ rxRequired: true });
    const rx = await issuedRx(p, [{ medicineId: med, quantity: 1 }]);
    const id = await otcOrder(p);
    await injectRxLine(id, med, rx, 1);
    const later = new Date(Date.now() + 60 * 24 * 3_600_000);
    await expect(transitionOrder(db, { role: 'PHARMACIST', userId: pharmacist.id }, id, 'verify', null, { actorId: pharmacist.id }, later))
      .rejects.toMatchObject({ status: 422, code: 'PRESCRIPTION_EXPIRED' });
  });

  it('a prescription already fulfilled by another live order is rejected at verification', async () => {
    const p = await makePatient();
    const med = await medicine({ rxRequired: true, initialStock: 10 });
    const rx = await issuedRx(p, [{ medicineId: med, quantity: 1 }]);
    await api('post', `/api/v1/patients/me/cart/prescriptions/${rx}`, p);
    const addr = (await db.query<{ id: string }>('SELECT id FROM patient_addresses WHERE patient_user_id = $1', [p.id])).rows[0]!.id;
    expect((await api('post', '/api/v1/patients/me/orders', p, { addressId: addr, paymentMethod: 'COD' }, { 'Idempotency-Key': idemKey() })).status).toBe(201);
    const second = await otcOrder(p);
    await injectRxLine(second, med, rx, 1);
    const r = await act(pharmacist, second, 'verify');
    expect(r.body.error.code).toBe('PRESCRIPTION_FULFILLED_ELSEWHERE');
  });

  it('a mismatched medicine on the prescription is rejected, and so is a mismatched quantity', async () => {
    const p = await makePatient();
    const med = await medicine({ rxRequired: true });
    const other = await medicine();
    const rx = await issuedRx(p, [{ medicineId: med, quantity: 2 }]);

    const wrongItem = await otcOrder(p);
    await injectRxLine(wrongItem, med, rx, 2);
    await injectRxLine(wrongItem, other, rx, 1); // a medicine that is not on the prescription
    expect((await act(pharmacist, wrongItem, 'verify')).body.error.code).toBe('PRESCRIPTION_MISMATCH');

    const wrongQty = await otcOrder(p);
    await injectRxLine(wrongQty, med, rx, 3); // prescribed 2
    expect((await act(pharmacist, wrongQty, 'verify')).body.error.code).toBe('PRESCRIPTION_MISMATCH');
  });

  it('verification never alters the prescription: its items and status are unchanged afterwards', async () => {
    const p = await makePatient();
    const med = await medicine({ rxRequired: true, initialStock: 10 });
    const rx = await issuedRx(p, [{ medicineId: med, quantity: 1 }]);
    const before = JSON.stringify((await db.query('SELECT status, rx_number, valid_till FROM prescriptions WHERE id = $1', [rx])).rows[0]);
    const id = await otcOrder(p);
    await injectRxLine(id, med, rx, 1);
    await act(pharmacist, id, 'verify');
    expect(JSON.stringify((await db.query('SELECT status, rx_number, valid_till FROM prescriptions WHERE id = $1', [rx])).rows[0])).toBe(before);
  });

  // ---- Lifecycle, reasons, events --------------------------------------------------------------

  it('invalid transitions are blocked, and every accepted step is an event with actor role and time', async () => {
    const p = await makePatient();
    const id = await otcOrder(p);
    expect((await act(pharmacist, id, 'deliver')).body.error.code).toBe('INVALID_TRANSITION');
    await act(pharmacist, id, 'verify');
    await act(pharmacist, id, 'pack');
    const detail = await api('get', `/api/v1/pharmacy/orders/${id}`, pharmacist);
    const actions = detail.body.data.events.map((e: { action: string }) => e.action);
    expect(actions).toEqual(['place', 'verify', 'pack']);
    expect(detail.body.data.events[1]).toMatchObject({ fromStatus: 'PLACED', toStatus: 'VERIFIED', actorRole: 'PHARMACIST' });
    expect(detail.body.data.events[0]).toMatchObject({ actorRole: 'PATIENT' });
    expect(detail.body.data.events[1].at).toEqual(expect.any(String));
  });

  it('rejection needs a reason, persists the reason and actor, and returns stock exactly once', async () => {
    const p = await makePatient();
    const otc = await medicine({ initialStock: 10, priceInr: 30 });
    await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: otc, quantity: 2 });
    const addr = (await db.query<{ id: string }>('SELECT id FROM patient_addresses WHERE patient_user_id = $1', [p.id])).rows[0]!.id;
    const id = (await api('post', '/api/v1/patients/me/orders', p, { addressId: addr, paymentMethod: 'COD' }, { 'Idempotency-Key': idemKey() })).body.data.id as string;
    expect(await stockOf(otc)).toBe(8);
    expect((await act(pharmacist, id, 'reject')).body.error.code).toBe('REASON_REQUIRED');
    const rej = await act(pharmacist, id, 'reject', 'Delivery area not serviceable');
    expect(rej.status).toBe(200);
    expect(rej.body.data.status).toBe('REJECTED');
    expect(await stockOf(otc)).toBe(10);
    const events = (await api('get', `/api/v1/pharmacy/orders/${id}`, pharmacist)).body.data.events;
    expect(events.at(-1)).toMatchObject({ action: 'reject', actorRole: 'PHARMACIST', reason: 'Delivery area not serviceable' });
    // A second restoration is impossible: the order is terminal and the ledger allows one restore per order and medicine.
    expect((await act(pharmacist, id, 'reject', 'Again, please')).body.error.code).toBe('INVALID_TRANSITION');
    expect((await db.query('SELECT 1 FROM stock_movements WHERE order_id = $1 AND reason = $2', [id, 'ORDER_RESTORE'])).rowCount).toBe(1);
    await expect(db.query(
      `INSERT INTO stock_movements (medicine_id, delta, balance_after, reason, order_id) VALUES ($1, 2, 12, 'ORDER_RESTORE', $2)`, [otc, id],
    )).rejects.toThrow(/stock_movements_order_restore_once/);
  });

  it('a rejected prescription order records the rejection and its reason against the prescription', async () => {
    const p = await makePatient();
    const med = await medicine({ rxRequired: true, initialStock: 10 });
    const rx = await issuedRx(p, [{ medicineId: med, quantity: 1 }]);
    await api('post', `/api/v1/patients/me/cart/prescriptions/${rx}`, p);
    const addr = (await db.query<{ id: string }>('SELECT id FROM patient_addresses WHERE patient_user_id = $1', [p.id])).rows[0]!.id;
    const id = (await api('post', '/api/v1/patients/me/orders', p, { addressId: addr, paymentMethod: 'COD' }, { 'Idempotency-Key': idemKey() })).body.data.id as string;
    await act(pharmacist, id, 'reject', 'Dose unclear on the prescription');
    const rec = await db.query<{ result: string; reason: string }>('SELECT result, reason FROM prescription_verifications WHERE order_id = $1', [id]);
    expect(rec.rows).toEqual([{ result: 'REJECTED', reason: 'Dose unclear on the prescription' }]);
    expect((await db.query<{ status: string }>('SELECT status FROM prescriptions WHERE id = $1', [rx])).rows[0]!.status).toBe('FULFILLED');
  });

  it('the event log cannot be edited or deleted, even directly in the database', async () => {
    const p = await makePatient();
    const id = await otcOrder(p);
    await act(pharmacist, id, 'verify');
    await expect(db.query('UPDATE order_events SET actor_role = $1 WHERE order_id = $2', ['PATIENT', id])).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM order_events WHERE order_id = $1', [id])).rejects.toThrow(/append-only/);
  });

  // ---- Inventory -------------------------------------------------------------------------------

  it('stock adjustments need a reason, cannot go negative, are recorded and audited', async () => {
    const med = await medicine({ initialStock: 3 });
    const zero = await api('post', `/api/v1/pharmacy/medicines/${med}/stock`, pharmacist, { delta: 0, note: 'Nothing changed' });
    expect(zero.status).toBe(422);
    const noReason = await api('post', `/api/v1/pharmacy/medicines/${med}/stock`, pharmacist, { delta: 2 });
    expect(noReason.status).toBe(422);
    const under = await api('post', `/api/v1/pharmacy/medicines/${med}/stock`, pharmacist, { delta: -5, note: 'Count correction' });
    expect(under.body.error.code).toBe('INSUFFICIENT_STOCK');
    const ok = await api('post', `/api/v1/pharmacy/medicines/${med}/stock`, pharmacist, { delta: 7, note: 'Goods received, invoice 881' });
    expect(ok.body.data).toMatchObject({ stockOnHand: 10 });
    const moves = (await api('get', `/api/v1/pharmacy/medicines/${med}/movements`, pharmacist)).body.data.items;
    expect(moves[0]).toMatchObject({ delta: 7, balanceAfter: 10, reason: 'ADJUSTMENT', note: 'Goods received, invoice 881' });
    const audit = await db.query<{ actor_user_id: string }>(`SELECT actor_user_id FROM audit_logs WHERE action = 'STOCK_ADJUSTED' AND entity_id = $1`, [med]);
    expect(audit.rows).toEqual([{ actor_user_id: pharmacist.id }]);
  });

  it('the low-stock view and dashboard count items at or below the threshold', async () => {
    // The shared test database holds many low-stock rows, so search for this run's medicine by its unique name.
    const tag = uniq();
    const low = await medicine({ initialStock: 4, name: `C7 low ${tag}` });
    const list = await api('get', `/api/v1/pharmacy/stock?lowOnly=true&q=${tag}`, pharmacist);
    expect(list.status).toBe(200);
    expect(list.body.data.lowStockThreshold).toBe(10);
    expect(list.body.data.items.map((i: { id: string }) => i.id)).toContain(low);
    expect(list.body.data.items.every((i: { availability: string }) => i.availability !== 'IN_STOCK')).toBe(true);
    const dash = await api('get', '/api/v1/pharmacy/dashboard/summary', pharmacist);
    expect(dash.body.data).toMatchObject({ lowStockThreshold: 10, awaitingVerification: expect.any(Number), lowStockItems: expect.any(Number) });
    expect(dash.body.data.lowStockItems).toBeGreaterThanOrEqual(1);
  });

  // ---- Access and clinical content -----------------------------------------------------------------

  it('the review shows what dispensing needs, and never diagnosis, advice or notes', async () => {
    const p = await makePatient();
    const med = await medicine({ rxRequired: true, initialStock: 10 });
    const rx = await issuedRx(p, [{ medicineId: med, quantity: 1 }]);
    await api('post', `/api/v1/patients/me/cart/prescriptions/${rx}`, p);
    const addr = (await db.query<{ id: string }>('SELECT id FROM patient_addresses WHERE patient_user_id = $1', [p.id])).rows[0]!.id;
    await api('post', '/api/v1/patients/me/orders', p, { addressId: addr, paymentMethod: 'COD' }, { 'Idempotency-Key': idemKey() });
    const review = await api('get', `/api/v1/pharmacy/prescriptions/${rx}`, pharmacist);
    expect(review.status).toBe(200);
    expect(review.body.data.items[0]).toMatchObject({ quantity: 1, dose: '10 mg' });
    expect(review.body.data.patient).toMatchObject({ name: 'Console Patient' });
    expect(JSON.stringify(review.body)).not.toMatch(/Confidential diagnosis|diagnosis|advice|examination|vitals/i);
  });

  it('a prescription that is not linked to pharmacy work is not visible to the pharmacist', async () => {
    const p = await makePatient();
    const med = await medicine({ rxRequired: true });
    const rx = await issuedRx(p, [{ medicineId: med, quantity: 1 }]);
    expect((await api('get', `/api/v1/pharmacy/prescriptions/${rx}`, pharmacist)).status).toBe(404);
  });

  it('pharmacists cannot change prescriptions, items or consultation content, by route or by database', async () => {
    const p = await makePatient();
    const med = await medicine({ rxRequired: true });
    const rx = await issuedRx(p, [{ medicineId: med, quantity: 1 }]);
    expect((await api('post', `/api/v1/doctor/prescriptions/${rx}/items`, pharmacist, { medicineId: med, dose: '1', frequency: 'x', durationDays: 1, quantity: 1 })).status).toBe(403);
    expect((await api('patch', `/api/v1/doctor/prescriptions/${rx}`, pharmacist, { advice: 'changed' })).status).toBe(403);
    expect((await api('post', `/api/v1/doctor/prescriptions/${rx}/issue`, pharmacist)).status).toBe(403);
    expect((await api('get', `/api/v1/doctor/patients/${p.id}/context`, pharmacist)).status).toBe(403);
    await expect(db.query('UPDATE prescription_items SET quantity = 9 WHERE prescription_id = $1', [rx])).rejects.toThrow(/only change while/);
    await expect(db.query(`UPDATE prescriptions SET advice = 'changed' WHERE id = $1`, [rx])).rejects.toThrow(/immutable/);
  });

  it('unauthorised roles are refused on every pharmacist route', async () => {
    const p = await makePatient();
    const id = await otcOrder(p);
    for (const path of ['/api/v1/pharmacy/dashboard/summary', '/api/v1/pharmacy/orders', `/api/v1/pharmacy/orders/${id}`, '/api/v1/pharmacy/stock']) {
      expect((await api('get', path, p)).status).toBe(403);
      expect((await api('get', path, doctor)).status).toBe(403);
      expect((await api('get', path)).status).toBe(401);
    }
    expect((await api('post', `/api/v1/pharmacy/orders/${id}/actions`, doctor, { action: 'verify' })).status).toBe(403);
    expect((await api('post', `/api/v1/pharmacy/medicines/${id}/stock`, admin, { delta: 1, note: 'Not allowed here' })).status).toBe(403);
  });
});
