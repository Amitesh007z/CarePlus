import 'dotenv/config';
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/common/logger.js';
import type { AuthLimits } from '../src/common/security/rateLimiter.js';
import { createDatabase, type Database } from '../src/infrastructure/database/pool.js';
import { upsertMedicineSeed } from '../src/modules/medicines/catalogue.seed.js';
import { addFromPrescription } from '../src/modules/commerce/cart.service.js';
import { placeOrder } from '../src/modules/commerce/orders.service.js';
import type { Mailer } from '../src/modules/commerce/notifications.js';
import { buildApp, testHasher } from './helpers.js';

// Real-database tests against Neon, through the HTTP app. Synthetic data only, under the test domain below.
const url = process.env.TEST_DATABASE_URL;
const DOMAIN = '@carepulse-c6.invalid';
const PASSWORD = 'Strong@123';
const roomy: AuthLimits = { windowSec: 900, loginPerIp: 100_000, loginFailuresPerIdentifier: 100, registerPerIp: 100_000 };
const MIN = 60_000;
const logger = createLogger('silent');
const uniq = () => `${Date.now().toString(36)}${randomInt(1e6).toString(36)}`;
const mobile = () => `9${String(randomInt(0, 1e9)).padStart(9, '0')}`;
const ADDRESS = { label: 'Home', line: '14 Test Lane, Indiranagar', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' };

interface Who {
  id: string;
  cookie: string;
  csrf: string;
}

describe.skipIf(!url)('C6: cart, prescription purchase, checkout, idempotency, stock safety and order lifecycle (integration)', () => {
  let db: Database;
  let app: ReturnType<typeof buildApp>;
  let admin: Who;
  let pharmacist: Who;
  let doctor: Who;
  let slotSeq = 0;
  const sent: { to: string }[] = [];
  const okMailer: Mailer = { send: async (m) => void sent.push({ to: m.to }) };
  const brokenMailer: Mailer = {
    send: async () => {
      throw new Error('SMTP down');
    },
  };

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
    await db.query(`INSERT INTO doctor_profiles (user_id, display_name, specialty, registration_no, experience_years) VALUES ($1, 'Dr Commerce', 'General Physician', $2, 7)`, [u.rows[0]!.id, `REG-${uniq()}`]);
    return login(email, u.rows[0]!.id);
  }
  async function makePatient(withAddress = true): Promise<Who> {
    const email = `pat${uniq()}${DOMAIN}`;
    const r = await request(app).post('/api/v1/auth/register').send({
      fullName: 'Shop Patient', email, mobile: mobile(), password: PASSWORD, dob: '1989-08-08', gender: 'FEMALE',
      bloodGroup: 'B+', addressLine: '1 Profile Road', city: 'Pune', state: 'Maharashtra', pincode: '411003',
      emergencyContactName: 'Kin', emergencyContactPhone: mobile(), consent: true,
    });
    const who = { id: r.body.data.user.id as string, cookie: cookieOf(r), csrf: r.body.data.csrfToken as string };
    if (withAddress) {
      const a = await api('post', '/api/v1/patients/me/addresses', who, ADDRESS);
      expect(a.status).toBe(201);
    }
    return who;
  }
  async function addressOf(p: Who): Promise<string> {
    return (await db.query<{ id: string }>('SELECT id FROM patient_addresses WHERE patient_user_id = $1 AND is_default', [p.id])).rows[0]!.id;
  }
  const newMedicine = (over: Record<string, unknown> = {}) => {
    const u = uniq();
    return { sku: `T6${u}`, name: `T6 Shop ${u}`, strength: '10 mg', form: 'Tablet', category: 'C6 Test', packSize: 'Strip of 10', priceInr: 100, rxRequired: false, allergyClass: null, description: null, manufacturer: null, chronicEligible: false, initialStock: 50, active: true, ...over };
  };
  async function medicine(over: Record<string, unknown> = {}): Promise<string> {
    const r = await api('post', '/api/v1/admin/medicines', admin, newMedicine(over));
    expect(r.status).toBe(201);
    return r.body.data.id as string;
  }
  const stockOf = async (id: string) => (await db.query<{ stock_qty: number }>('SELECT stock_qty FROM medicines WHERE id = $1', [id])).rows[0]!.stock_qty;
  const orderCount = async (p: Who) => (await db.query('SELECT 1 FROM orders WHERE patient_user_id = $1', [p.id])).rowCount;
  const idemKey = () => `k-${randomUUID()}`;

  async function finalizedConsultation(pat: Who): Promise<string> {
    slotSeq++;
    const at = new Date(Date.now() + (2 + slotSeq * 0.05) * MIN + 777);
    const slot = await db.query<{ id: string }>(`INSERT INTO appointment_slots (doctor_user_id, starts_at, ends_at) VALUES ($1, $2, $2::timestamptz + interval '30 minutes') RETURNING id`, [doctor.id, at.toISOString()]);
    const booked = await api('post', '/api/v1/appointments', pat, { slotId: slot.rows[0]!.id, chiefComplaint: 'Cough', symptoms: ['cough'], durationDays: 2, severity: 'MILD' });
    const apptId = booked.body.data.id as string;
    await api('patch', `/api/v1/doctor/appointments/${apptId}/status`, doctor, { status: 'CONFIRMED' });
    const cid = (await api('post', `/api/v1/doctor/appointments/${apptId}/consultation`, doctor)).body.data.id as string;
    await api('put', `/api/v1/doctor/consultations/${cid}`, doctor, { chiefComplaint: 'Cough', examinationNotes: null, diagnosisDescription: 'Test', severity: 'MILD', followUpOn: null, vitals: null });
    await api('post', `/api/v1/doctor/consultations/${cid}/finalize`, doctor);
    return cid;
  }
  /** Issues a prescription with the given lines and returns its id. */
  async function issuedRx(pat: Who, lines: { medicineId: string; quantity: number }[]): Promise<string> {
    const cid = await finalizedConsultation(pat);
    const rxId = (await api('post', `/api/v1/doctor/consultations/${cid}/prescriptions`, doctor)).body.data.id as string;
    for (const l of lines) {
      expect((await api('post', `/api/v1/doctor/prescriptions/${rxId}/items`, doctor, { medicineId: l.medicineId, dose: '10 mg', frequency: 'Once', durationDays: 3, quantity: l.quantity })).status).toBe(201);
    }
    expect((await api('post', `/api/v1/doctor/prescriptions/${rxId}/issue`, doctor)).status).toBe(200);
    return rxId;
  }

  beforeAll(async () => {
    db = createDatabase({ connectionString: url as string, max: 6, logger });
    app = buildApp(db, { limits: roomy, mailer: okMailer });
    await upsertMedicineSeed(db);
    admin = await makeStaff('ADMIN');
    pharmacist = await makeStaff('PHARMACIST');
    doctor = await makeDoctor();
  });

  /** Order body builder: the address id is read from the patient's default address. */
  const orderBody = async (p: Who, method: 'COD' | 'MOCK_CARD' = 'COD') => ({ addressId: await addressOf(p), paymentMethod: method });
  const place = async (p: Who, key = idemKey(), method: 'COD' | 'MOCK_CARD' = 'COD') =>
    api('post', '/api/v1/patients/me/orders', p, await orderBody(p, method), { 'Idempotency-Key': key });

  // ---- Cart and OTC checkout ------------------------------------------------------------------

  it('OTC: cart totals are server-side, checkout places the order, decrements stock and clears the cart', async () => {
    const p = await makePatient();
    const med = await medicine({ priceInr: 140, initialStock: 10 });
    const added = await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 2 });
    expect(added.status).toBe(201);
    expect(added.body.data.summary).toMatchObject({ subtotalInr: 280, discountInr: 0, deliveryFeeInr: 40, totalInr: 320, isPrescriptionOrder: false });
    expect(added.body.data.blockers).toEqual([]);

    const placed = await place(p);
    expect(placed.status).toBe(201);
    expect(placed.body.data).toMatchObject({ status: 'PLACED', replayed: false, totalInr: 320, deliveryFeeInr: 40, paymentStatus: 'PENDING', paymentMethod: 'COD' });
    expect(placed.body.data.items[0]).toMatchObject({ quantity: 2, unitPriceInr: 140, lineTotalInr: 280 });
    expect(placed.body.data.explanation.at(-1)).toBe('Total: INR 320.00');
    expect(await stockOf(med)).toBe(8);
    expect((await api('get', '/api/v1/patients/me/cart', p)).body.data.items).toEqual([]);
    const mv = await db.query<{ delta: number; reason: string }>(`SELECT delta, reason FROM stock_movements WHERE medicine_id = $1 AND reason = 'ORDER' ORDER BY created_at`, [med]);
    expect(mv.rows).toEqual([{ delta: -2, reason: 'ORDER' }]);
    expect(sent.some((s) => s.to.startsWith('pat'))).toBe(true);
  });

  it('free delivery applies above INR 299 for OTC orders and the cart shows the explanation', async () => {
    const p = await makePatient();
    const med = await medicine({ priceInr: 150, initialStock: 10 });
    await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 2 });
    const cart = await api('get', '/api/v1/patients/me/cart', p);
    expect(cart.body.data.summary).toMatchObject({ subtotalInr: 300, deliveryFeeInr: 0, totalInr: 300, freeDelivery: true });
  });

  it('a prescription-only medicine cannot be added to the cart without a prescription', async () => {
    const p = await makePatient();
    const med = await medicine({ rxRequired: true });
    const r = await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 1 });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('RX_REQUIRED');
  });

  it('Rx-only medicine injected straight into the cart is still blocked at checkout, and stock is untouched', async () => {
    const p = await makePatient();
    const med = await medicine({ rxRequired: true, initialStock: 5 });
    const cartId = (await db.query<{ id: string }>('INSERT INTO carts (patient_user_id) VALUES ($1) RETURNING id', [p.id])).rows[0]!.id;
    await db.query('INSERT INTO cart_items (cart_id, medicine_id, quantity) VALUES ($1, $2, 1)', [cartId, med]);
    const r = await place(p);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('RX_REQUIRED');
    expect(await stockOf(med)).toBe(5);
    expect(await orderCount(p)).toBe(0);
  });

  it('the checkout requires an Idempotency-Key header and a saved address', async () => {
    const p = await makePatient();
    await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: await medicine(), quantity: 1 });
    const noKey = await api('post', '/api/v1/patients/me/orders', p, await orderBody(p));
    expect(noKey.status).toBe(422);
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const badAddr = await api('post', '/api/v1/patients/me/orders', p, { addressId: '6f1c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6', paymentMethod: 'COD' }, { 'Idempotency-Key': idemKey() });
    expect(badAddr.body.error.code).toBe('ADDRESS_NOT_FOUND');
  });

  it('cart quantities are limited and an OTC line can be updated and removed', async () => {
    const p = await makePatient();
    const med = await medicine();
    const a = await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 100 });
    expect(a.status).toBe(201);
    expect((await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 1 })).body.error.code).toBe('QUANTITY_LIMIT');
    const itemId = a.body.data.items[0].id as string;
    const u = await api('patch', `/api/v1/patients/me/cart/items/${itemId}`, p, { quantity: 3 });
    expect(u.body.data.items[0].quantity).toBe(3);
    expect((await api('delete', `/api/v1/patients/me/cart/items/${itemId}`, p)).body.data.items).toEqual([]);
  });

  // ---- Prescription purchase -----------------------------------------------------------------

  it('a valid prescription purchase uses exactly the prescribed lines, takes 10% off, and fulfils the prescription', async () => {
    const p = await makePatient();
    const med = await medicine({ rxRequired: true, priceInr: 118, initialStock: 10 });
    const rx = await issuedRx(p, [{ medicineId: med, quantity: 2 }]);
    const cart = await api('post', `/api/v1/patients/me/cart/prescriptions/${rx}`, p);
    expect(cart.status).toBe(201);
    expect(cart.body.data.items[0]).toMatchObject({ source: 'PRESCRIPTION', locked: true, quantity: 2 });
    expect(cart.body.data.summary).toMatchObject({ subtotalInr: 236, discountInr: 23.6, deliveryFeeInr: 0, totalInr: 212.4, isPrescriptionOrder: true });

    const locked = await api('patch', `/api/v1/patients/me/cart/items/${cart.body.data.items[0].id}`, p, { quantity: 5 });
    expect(locked.body.error.code).toBe('PRESCRIPTION_LINE_LOCKED');
    expect((await api('delete', `/api/v1/patients/me/cart/items/${cart.body.data.items[0].id}`, p)).body.error.code).toBe('PRESCRIPTION_LINE_LOCKED');

    const placed = await place(p);
    expect(placed.status).toBe(201);
    expect(placed.body.data).toMatchObject({ isPrescriptionOrder: true, discountInr: 23.6, deliveryFeeInr: 0, totalInr: 212.4 });
    expect(placed.body.data.items[0]).toMatchObject({ quantity: 2, prescriptionRxNumber: expect.any(String) });
    expect(await stockOf(med)).toBe(8);
    expect((await db.query<{ status: string }>('SELECT status FROM prescriptions WHERE id = $1', [rx])).rows[0]!.status).toBe('FULFILLED');
  });

  it('a prescription that is already fulfilled cannot be bought again', async () => {
    const p = await makePatient();
    const med = await medicine({ rxRequired: true, initialStock: 10 });
    const rx = await issuedRx(p, [{ medicineId: med, quantity: 1 }]);
    expect((await api('post', `/api/v1/patients/me/cart/prescriptions/${rx}`, p)).status).toBe(201);
    expect((await place(p)).status).toBe(201);
    const again = await api('post', `/api/v1/patients/me/cart/prescriptions/${rx}`, p);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_FULFILLED');
  });

  it('another patient cannot buy someone else’s prescription, and a draft is not found', async () => {
    const owner = await makePatient();
    const other = await makePatient();
    const med = await medicine({ rxRequired: true });
    const rx = await issuedRx(owner, [{ medicineId: med, quantity: 1 }]);
    expect((await api('post', `/api/v1/patients/me/cart/prescriptions/${rx}`, other)).status).toBe(404);
    const cid = await finalizedConsultation(owner);
    const draft = (await api('post', `/api/v1/doctor/consultations/${cid}/prescriptions`, doctor)).body.data.id as string;
    expect((await api('post', `/api/v1/patients/me/cart/prescriptions/${draft}`, owner)).status).toBe(404);
  });

  it('an expired prescription is refused both when added and at checkout (checked with a later clock)', async () => {
    const p = await makePatient();
    const med = await medicine({ rxRequired: true, initialStock: 10 });
    const rx = await issuedRx(p, [{ medicineId: med, quantity: 1 }]);
    const future = new Date(Date.now() + 60 * 24 * 3_600_000);
    await expect(addFromPrescription(db, p.id, rx, future)).rejects.toMatchObject({ status: 422, code: 'EXPIRED' });
    expect((await api('post', `/api/v1/patients/me/cart/prescriptions/${rx}`, p)).status).toBe(201);
    await expect(placeOrder(db, p.id, idemKey(), { addressId: await addressOf(p), paymentMethod: 'COD' }, { actorId: p.id }, null, future))
      .rejects.toMatchObject({ status: 422 });
    expect(await orderCount(p)).toBe(0);
  });

  it('a prescription that has been sent to a pharmacy cannot be bought at the same time', async () => {
    const p = await makePatient();
    const med = await medicine({ rxRequired: true, initialStock: 10 });
    const rx = await issuedRx(p, [{ medicineId: med, quantity: 1 }]);
    expect((await api('post', `/api/v1/patients/me/prescriptions/${rx}/fulfilment`, p)).status).toBe(201);
    const r = await api('post', `/api/v1/patients/me/cart/prescriptions/${rx}`, p);
    expect(r.body.error.code).toBe('WITH_PHARMACY');
  });

  it('the cart must match the prescription exactly: a changed prescription line is refused at checkout', async () => {
    const p = await makePatient();
    const med = await medicine({ rxRequired: true, initialStock: 10 });
    const rx = await issuedRx(p, [{ medicineId: med, quantity: 2 }]);
    await api('post', `/api/v1/patients/me/cart/prescriptions/${rx}`, p);
    await db.query('UPDATE cart_items SET quantity = 1 WHERE prescription_id = $1', [rx]);
    const r = await place(p);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('PRESCRIPTION_MISMATCH');
  });

  // ---- Client tampering --------------------------------------------------------------------------

  it('client price, total, discount and stock values are refused by the schemas', async () => {
    const p = await makePatient();
    const med = await medicine({ priceInr: 50 });
    const add = await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 1, unitPriceInr: 1 });
    expect(add.status).toBe(422);
    await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 1 });
    for (const extra of [{ totalInr: 1 }, { discountInr: 100 }, { stock: 9999 }, { subtotalInr: 0 }]) {
      const r = await api('post', '/api/v1/patients/me/orders', p, { ...(await orderBody(p)), ...extra }, { 'Idempotency-Key': idemKey() });
      expect(r.status).toBe(422);
    }
    expect(await orderCount(p)).toBe(0);
  });

  it('the server reprices from the catalogue at checkout, whatever the cart displayed', async () => {
    const p = await makePatient();
    const med = await medicine({ priceInr: 100, initialStock: 10 });
    await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 1 });
    await db.query('UPDATE medicines SET price_inr = 200 WHERE id = $1', [med]);
    const placed = await place(p);
    expect(placed.body.data.subtotalInr).toBe(200);
    expect(placed.body.data.items[0].unitPriceInr).toBe(200);
  });

  // ---- Concurrency and idempotency ------------------------------------------------------------------

  it('two patients racing for the last unit: exactly one order succeeds and stock never goes negative', async () => {
    const med = await medicine({ initialStock: 1 });
    const a = await makePatient();
    const b = await makePatient();
    await api('post', '/api/v1/patients/me/cart/items', a, { medicineId: med, quantity: 1 });
    await api('post', '/api/v1/patients/me/cart/items', b, { medicineId: med, quantity: 1 });
    const [ra, rb] = await Promise.all([place(a), place(b)]);
    const codes = [ra.status, rb.status].sort();
    expect(codes).toEqual([201, 409]);
    expect(await stockOf(med)).toBe(0);
    const failed = ra.status === 409 ? ra : rb;
    expect(failed.body.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('a stock request beyond what exists is refused and leaves stock alone', async () => {
    const med = await medicine({ initialStock: 2 });
    const p = await makePatient();
    await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 3 });
    const r = await place(p);
    expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(med)).toBe(2);
  });

  it('duplicate idempotency key: the retry returns the original order and creates nothing new', async () => {
    const p = await makePatient();
    const med = await medicine({ initialStock: 10 });
    await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 1 });
    const key = idemKey();
    const first = await place(p, key);
    expect(first.status).toBe(201);
    const retry = await place(p, key);
    expect(retry.status).toBe(200);
    expect(retry.body.data).toMatchObject({ id: first.body.data.id, replayed: true });
    expect(await stockOf(med)).toBe(9);
    expect(await orderCount(p)).toBe(1);
  });

  it('the same key with a different body is refused rather than replayed', async () => {
    const p = await makePatient();
    const med = await medicine({ initialStock: 10 });
    await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 1 });
    const key = idemKey();
    expect((await place(p, key, 'COD')).status).toBe(201);
    const other = await place(p, key, 'MOCK_CARD');
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('a different key is a distinct attempt: an empty cart is refused, a refilled cart makes a new order', async () => {
    const p = await makePatient();
    const med = await medicine({ initialStock: 10 });
    await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 1 });
    const first = await place(p);
    expect(first.status).toBe(201);
    const empty = await place(p);
    expect(empty.body.error.code).toBe('CART_EMPTY');
    await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 1 });
    const second = await place(p);
    expect(second.status).toBe(201);
    expect(second.body.data.id).not.toBe(first.body.data.id);
    expect(await orderCount(p)).toBe(2);
  });

  it('a failure part-way through checkout rolls back every write: no order, no stock change, cart kept', async () => {
    const p = await makePatient();
    const med = await medicine({ initialStock: 10 });
    await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 2 });
    // Inject a failure at the payment insert, after the stock has been decremented and the order written.
    const faulty: Database = {
      query: db.query.bind(db),
      close: db.close.bind(db),
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            query: (text, params) => {
              if (text.includes('INSERT INTO payments')) throw new Error('injected payment failure');
              return tx.query(text, params);
            },
          }),
        ),
    };
    await expect(placeOrder(faulty, p.id, idemKey(), { addressId: await addressOf(p), paymentMethod: 'COD' }, { actorId: p.id }, null)).rejects.toThrow('injected');
    expect(await stockOf(med)).toBe(10);
    expect(await orderCount(p)).toBe(0);
    expect((await api('get', '/api/v1/patients/me/cart', p)).body.data.items).toHaveLength(1);
    expect((await db.query("SELECT 1 FROM stock_movements WHERE medicine_id = $1 AND reason = 'ORDER'", [med])).rowCount).toBe(0);
  });

  // ---- Confirmation email ----------------------------------------------------------------------------

  it('an email failure after commit does not undo the order; the confirmation is kept for retry', async () => {
    const p = await makePatient();
    const med = await medicine({ initialStock: 10 });
    await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 1 });
    const app2 = buildApp(db, { limits: roomy, mailer: brokenMailer });
    const r = await request(app2).post('/api/v1/patients/me/orders').set('Cookie', p.cookie).set('X-CSRF-Token', p.csrf)
      .set('Idempotency-Key', idemKey()).send(await orderBody(p));
    expect(r.status).toBe(201);
    expect(await orderCount(p)).toBe(1);
    const n = await db.query<{ status: string; attempts: number }>(
      `SELECT n.status, n.attempts FROM notifications n JOIN orders o ON o.id = n.order_id WHERE o.id = $1`,
      [r.body.data.id],
    );
    expect(n.rows[0]).toMatchObject({ status: 'FAILED', attempts: 1 });
  });

  // ---- Lifecycle and stock restoration ---------------------------------------------------------

  it('cancellation restores stock exactly once; a second cancel or a reject afterwards is refused', async () => {
    const p = await makePatient();
    const med = await medicine({ initialStock: 10 });
    await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 3 });
    const placed = await place(p);
    const id = placed.body.data.id as string;
    expect(await stockOf(med)).toBe(7);
    const cancelled = await api('post', `/api/v1/patients/me/orders/${id}/cancel`, p, { reason: 'Changed my mind' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', statusReason: 'Changed my mind' });
    expect(await stockOf(med)).toBe(10);
    expect((await api('post', `/api/v1/patients/me/orders/${id}/cancel`, p)).body.error.code).toBe('INVALID_TRANSITION');
    expect((await api('post', `/api/v1/pharmacy/orders/${id}/actions`, pharmacist, { action: 'reject', reason: 'Too late' })).status).toBe(409);
    expect(await stockOf(med)).toBe(10);
    const restores = await db.query('SELECT 1 FROM stock_movements WHERE order_id = $1 AND reason = $2', [id, 'ORDER_RESTORE']);
    expect(restores.rowCount).toBe(1);
  });

  it('pharmacist rejection requires a reason, restores stock once, and the cancelled-payment is voided or refunded', async () => {
    const p = await makePatient();
    const med = await medicine({ initialStock: 10 });
    await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 2 });
    const id = (await place(p, idemKey(), 'MOCK_CARD')).body.data.id as string;
    expect((await api('post', `/api/v1/pharmacy/orders/${id}/actions`, pharmacist, { action: 'reject' })).body.error.code).toBe('REASON_REQUIRED');
    const rejected = await api('post', `/api/v1/pharmacy/orders/${id}/actions`, pharmacist, { action: 'reject', reason: 'Address not serviceable' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data).toMatchObject({ status: 'REJECTED', paymentStatus: 'REFUNDED' });
    expect(await stockOf(med)).toBe(10);
  });

  it('the pharmacist moves a placed order forward and cash on delivery is collected at delivery', async () => {
    const p = await makePatient();
    const med = await medicine({ initialStock: 10 });
    await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 1 });
    const id = (await place(p)).body.data.id as string;
    const act = (action: string) => api('post', `/api/v1/pharmacy/orders/${id}/actions`, pharmacist, { action });
    expect((await act('deliver')).body.error.code).toBe('INVALID_TRANSITION');
    expect((await act('verify')).body.data.status).toBe('VERIFIED');
    expect((await act('pack')).body.data.status).toBe('PACKED');
    expect((await act('dispatch')).body.data.status).toBe('OUT_FOR_DELIVERY');
    const done = await act('deliver');
    expect(done.body.data).toMatchObject({ status: 'DELIVERED', paymentStatus: 'COLLECTED' });
    expect(done.body.data.timeline.deliveredAt).toEqual(expect.any(String));
  });

  it('a prescription order is verified: the pharmacist check is recorded per prescription', async () => {
    const p = await makePatient();
    const med = await medicine({ rxRequired: true, initialStock: 10 });
    const rx = await issuedRx(p, [{ medicineId: med, quantity: 1 }]);
    await api('post', `/api/v1/patients/me/cart/prescriptions/${rx}`, p);
    const id = (await place(p)).body.data.id as string;
    const v = await api('post', `/api/v1/pharmacy/orders/${id}/actions`, pharmacist, { action: 'verify' });
    expect(v.status).toBe(200);
    const rec = await db.query<{ result: string; prescription_id: string }>('SELECT result, prescription_id FROM prescription_verifications WHERE order_id = $1', [id]);
    expect(rec.rows).toEqual([{ result: 'PASSED', prescription_id: rx }]);
  });

  it('a placed order keeps its snapshot after catalogue price and name changes', async () => {
    const p = await makePatient();
    const med = await medicine({ priceInr: 80, initialStock: 10, name: 'T6 Snapshot Original' });
    await api('post', '/api/v1/patients/me/cart/items', p, { medicineId: med, quantity: 1 });
    const id = (await place(p)).body.data.id as string;
    await api('patch', `/api/v1/admin/medicines/${med}`, admin, { priceInr: 999, name: 'T6 Snapshot Renamed' });
    const detail = await api('get', `/api/v1/patients/me/orders/${id}`, p);
    expect(detail.body.data.items[0]).toMatchObject({ name: 'T6 Snapshot Original', unitPriceInr: 80 });
    expect(detail.body.data.totalInr).toBe(120);
    await expect(db.query('UPDATE order_items SET unit_price_inr = 1 WHERE order_id = $1', [id])).rejects.toThrow(/immutable/);
  });

  // ---- Visibility and roles ------------------------------------------------------------------------

  it('a patient sees only their own orders, and patients and doctors cannot use pharmacist routes', async () => {
    const owner = await makePatient();
    const other = await makePatient();
    const med = await medicine({ initialStock: 10 });
    await api('post', '/api/v1/patients/me/cart/items', owner, { medicineId: med, quantity: 1 });
    const id = (await place(owner)).body.data.id as string;
    expect((await api('get', `/api/v1/patients/me/orders/${id}`, other)).status).toBe(404);
    expect((await api('post', `/api/v1/patients/me/orders/${id}/cancel`, other)).status).toBe(404);
    expect((await api('get', `/api/v1/patients/me/orders`, owner)).body.data.items.map((o: { id: string }) => o.id)).toContain(id);
    expect((await api('get', `/api/v1/pharmacy/orders/${id}`, owner)).status).toBe(403);
    expect((await api('get', `/api/v1/pharmacy/orders`, doctor)).status).toBe(403);
    expect((await api('post', `/api/v1/pharmacy/orders/${id}/actions`, owner, { action: 'verify' })).status).toBe(403);
    expect((await api('get', `/api/v1/patients/me/cart`)).status).toBe(401);
  });

  it('pharmacist order detail shows the patient and prescription references, not clinical notes', async () => {
    const p = await makePatient();
    const med = await medicine({ rxRequired: true, initialStock: 10 });
    const rx = await issuedRx(p, [{ medicineId: med, quantity: 1 }]);
    await api('post', `/api/v1/patients/me/cart/prescriptions/${rx}`, p);
    const id = (await place(p)).body.data.id as string;
    const detail = await api('get', `/api/v1/pharmacy/orders/${id}`, pharmacist);
    expect(detail.status).toBe(200);
    expect(detail.body.data.patient).toEqual({ name: 'Shop Patient' });
    expect(detail.body.data.prescriptions[0]).toHaveProperty('rxNumber');
    expect(JSON.stringify(detail.body)).not.toMatch(/diagnosis|allerg|consultation/i);
  });
});
