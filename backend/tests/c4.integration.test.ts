import 'dotenv/config';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/common/logger.js';
import type { AuthLimits } from '../src/common/security/rateLimiter.js';
import { createDatabase, type Database } from '../src/infrastructure/database/pool.js';
import { upsertMedicineSeed } from '../src/modules/medicines/catalogue.seed.js';
import { getForPatient, markFulfilled } from '../src/modules/prescriptions/prescriptions.service.js';
import { buildApp, testHasher } from './helpers.js';

// Real-database tests against Neon. Issued prescriptions are immutable by design, so these rows stay
// in the database under the test domain below.
const url = process.env.TEST_DATABASE_URL;
const DOMAIN = '@carepulse-c4.invalid';
const PASSWORD = 'Strong@123';
const roomy: AuthLimits = { windowSec: 900, loginPerIp: 100_000, loginFailuresPerIdentifier: 100, registerPerIp: 100_000 };
const MIN = 60_000;

interface Who {
  id: string;
  cookie: string;
  csrf: string;
}

const uniq = () => `${Date.now().toString(36)}${randomInt(1e6).toString(36)}`;
const mobile = () => `9${String(randomInt(0, 1e9)).padStart(9, '0')}`;

describe.skipIf(!url)('C4: prescriptions, allergy safety, lifecycle and access (integration)', () => {
  let db: Database;
  let app: ReturnType<typeof buildApp>;
  let doctorA: Who;
  let doctorB: Who;
  let anita: Who; // penicillin allergy recorded
  let vikram: Who; // no allergies
  let slotSeq = 0;
  const med: Record<string, string> = {};

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

  async function makeDoctor(): Promise<Who> {
    const email = `doc${uniq()}${DOMAIN}`;
    const u = await db.query<{ id: string }>(`INSERT INTO users (role, email, mobile, password_hash) VALUES ('DOCTOR', $1, $2, $3) RETURNING id`, [email, mobile(), await testHasher.hash(PASSWORD)]);
    const id = u.rows[0]!.id;
    await db.query(`INSERT INTO doctor_profiles (user_id, display_name, specialty, registration_no, experience_years) VALUES ($1, 'Dr Rx', 'General Physician', $2, 8)`, [id, `REG-${uniq()}`]);
    return login(email, id);
  }

  async function makePatient(): Promise<Who> {
    const email = `pat${uniq()}${DOMAIN}`;
    const r = await request(app).post('/api/v1/auth/register').send({
      fullName: 'Rx Patient', email, mobile: mobile(), password: PASSWORD, dob: '1991-06-06', gender: 'FEMALE',
      bloodGroup: 'A+', addressLine: '9 Script Road', city: 'Pune', state: 'Maharashtra', pincode: '411003',
      emergencyContactName: 'Kin Person', emergencyContactPhone: mobile(), consent: true,
    });
    return { id: r.body.data.user.id as string, cookie: cookieOf(r), csrf: r.body.data.csrfToken as string };
  }

  /** Books, confirms and opens a consultation. Optionally finalizes it. Returns the consultation id. */
  async function consultation(doc: Who, pat: Who, finalize: boolean): Promise<string> {
    slotSeq++;
    const at = new Date(Date.now() + (2 + slotSeq * 0.05) * MIN + 1234);
    const slot = await db.query<{ id: string }>(
      `INSERT INTO appointment_slots (doctor_user_id, starts_at, ends_at) VALUES ($1, $2, $2::timestamptz + interval '30 minutes') RETURNING id`,
      [doc.id, at.toISOString()],
    );
    const booked = await api('post', '/api/v1/appointments', pat, {
      slotId: slot.rows[0]!.id, chiefComplaint: 'Sore throat and fever', symptoms: ['fever'], durationDays: 2, severity: 'MILD',
    });
    const apptId = booked.body.data.id as string;
    await api('patch', `/api/v1/doctor/appointments/${apptId}/status`, doc, { status: 'CONFIRMED' });
    const opened = await api('post', `/api/v1/doctor/appointments/${apptId}/consultation`, doc);
    const cid = opened.body.data.id as string;
    const draft = { chiefComplaint: 'Sore throat and fever', examinationNotes: null, diagnosisDescription: 'Viral pharyngitis (provisional)', severity: 'MILD', followUpOn: null, vitals: null };
    await api('put', `/api/v1/doctor/consultations/${cid}`, doc, draft);
    if (finalize) await api('post', `/api/v1/doctor/consultations/${cid}/finalize`, doc);
    return cid;
  }

  const newDraft = (doc: Who, cid: string) => api('post', `/api/v1/doctor/consultations/${cid}/prescriptions`, doc);
  const addLine = (doc: Who, rxId: string, sku: string, quantity = 3, durationDays = 3) =>
    api('post', `/api/v1/doctor/prescriptions/${rxId}/items`, doc, {
      medicineId: med[sku], dose: '500 mg', frequency: 'Once a day', durationDays, quantity, instructions: 'After food',
    });

  beforeAll(async () => {
    db = createDatabase({ connectionString: url as string, max: 6, logger: createLogger('silent') });
    app = buildApp(db, { limits: roomy });
    await upsertMedicineSeed(db);
    for (const row of (await db.query<{ id: string; sku: string }>('SELECT id, sku FROM medicines')).rows) med[row.sku] = row.id;
    doctorA = await makeDoctor();
    doctorB = await makeDoctor();
    anita = await makePatient();
    vikram = await makePatient();
    // Anita has a penicillin allergy record, created through the real API with her consent.
    const allergy = await api('post', '/api/v1/patients/me/health-info', anita, { type: 'ALLERGY', name: 'Penicillin', allergyClass: 'Penicillin', severity: 'SEVERE', notedOn: '2015-03-10' });
    expect(allergy.status).toBe(201);
  });

  it('a valid draft is created on a finalized consultation and previews as issuable', async () => {
    const cid = await consultation(doctorA, vikram, true);
    const created = await newDraft(doctorA, cid);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'DRAFT', rxNumber: null, consultationId: cid });
    const rxId = created.body.data.id as string;

    const line = await addLine(doctorA, rxId, 'MED-1001', 6, 3);
    expect(line.status).toBe(201);
    expect(line.body.data.items[0]).toMatchObject({ dose: '500 mg', quantity: 6, durationDays: 3, medicine: { sku: 'MED-1001' } });
    expect(line.body.data.checks).toMatchObject({ allergyMatches: [], canIssue: true, blockers: [] });
  });

  it('rejects an invalid medicine, a malformed line, and bad quantities or durations', async () => {
    const cid = await consultation(doctorA, vikram, true);
    const rxId = (await newDraft(doctorA, cid)).body.data.id as string;
    expect((await api('post', `/api/v1/doctor/prescriptions/${rxId}/items`, doctorA, { medicineId: '6f1c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6', dose: '1', frequency: 'x', durationDays: 1, quantity: 1 })).body.error.code).toBe('INVALID_MEDICINE');
    expect((await api('post', `/api/v1/doctor/prescriptions/${rxId}/items`, doctorA, { medicineId: 'nope', dose: '1', frequency: 'x', durationDays: 1, quantity: 1 })).status).toBe(422);
    expect((await addLine(doctorA, rxId, 'MED-1001', 0)).status).toBe(422);
    expect((await addLine(doctorA, rxId, 'MED-1001', 101)).status).toBe(422);
    expect((await addLine(doctorA, rxId, 'MED-1001', 3, 0)).status).toBe(422);
    expect((await api('post', `/api/v1/doctor/prescriptions/${rxId}/items`, doctorA, { medicineId: med['MED-1001'], dose: '1', frequency: 'x', durationDays: 1, quantity: 1, price: 0 })).status).toBe(422);
  });

  it('wrong doctor and wrong patient cannot reach a prescription; a missing consultation is not found', async () => {
    const cid = await consultation(doctorA, vikram, true);
    const rxId = (await newDraft(doctorA, cid)).body.data.id as string;
    await addLine(doctorA, rxId, 'MED-1007', 1, 2);
    expect((await newDraft(doctorB, cid)).status).toBe(404);
    expect((await api('get', `/api/v1/doctor/prescriptions/${rxId}`, doctorB)).status).toBe(404);
    expect((await addLine(doctorB, rxId, 'MED-1007')).status).toBe(404);
    expect((await api('post', `/api/v1/doctor/prescriptions/${rxId}/issue`, doctorB)).status).toBe(404);
    expect((await newDraft(doctorA, '6f1c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6')).status).toBe(404);
    // A draft is invisible to the patient, and another patient cannot read the record.
    expect((await api('get', `/api/v1/patients/me/prescriptions/${rxId}`, vikram)).status).toBe(404);
    expect((await api('get', `/api/v1/patients/me/prescriptions/${rxId}`, anita)).status).toBe(404);
  });

  it('the database refuses a prescription that points at another patient\'s consultation', async () => {
    const cid = await consultation(doctorA, vikram, true);
    await expect(
      db.query(`INSERT INTO prescriptions (consultation_id, patient_user_id, doctor_user_id) VALUES ($1, $2, $3)`, [cid, anita.id, doctorA.id]),
    ).rejects.toThrow(/prescriptions_consultation_fk|foreign key/);
  });

  it('an unfinalized consultation can be drafted but not issued', async () => {
    const cid = await consultation(doctorA, vikram, false);
    const rxId = (await newDraft(doctorA, cid)).body.data.id as string;
    await addLine(doctorA, rxId, 'MED-1007', 1, 2);
    const issue = await api('post', `/api/v1/doctor/prescriptions/${rxId}/issue`, doctorA);
    expect(issue.status).toBe(422);
    expect(issue.body.error.code).toBe('CONSULTATION_NOT_FINALIZED');
  });

  it('allergy match: a penicillin-class medicine is flagged, blocked at issue, and the block is audited', async () => {
    const cid = await consultation(doctorA, anita, true);
    const rxId = (await newDraft(doctorA, cid)).body.data.id as string;
    const line = await addLine(doctorA, rxId, 'MED-1002', 6, 5);
    expect(line.body.data.checks.allergyMatches).toEqual([expect.objectContaining({ medicineSku: 'MED-1002', allergyClass: 'Penicillin' })]);
    expect(line.body.data.checks.canIssue).toBe(false);

    const issue = await api('post', `/api/v1/doctor/prescriptions/${rxId}/issue`, doctorA);
    expect(issue.status).toBe(422);
    expect(issue.body.error.code).toBe('ALLERGY_CONFLICT');
    expect(issue.body.error.details[0].path).toBe('items.MED-1002');

    const audit = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE entity_id = $1 AND action = 'PRESCRIPTION_ALLERGY_BLOCKED'`, [rxId]);
    expect(audit.rows[0]!.n).toBe(1);
    const stillDraft = await api('get', `/api/v1/doctor/prescriptions/${rxId}`, doctorA);
    expect(stillDraft.body.data.status).toBe('DRAFT');
  });

  it('non-match: the same drug is allowed for a patient without that allergy, and a non-conflicting drug is issued', async () => {
    const cidV = await consultation(doctorA, vikram, true);
    const rxV = (await newDraft(doctorA, cidV)).body.data.id as string;
    await addLine(doctorA, rxV, 'MED-1002', 6, 5);
    expect((await api('post', `/api/v1/doctor/prescriptions/${rxV}/issue`, doctorA)).status).toBe(200);

    const cidA = await consultation(doctorA, anita, true);
    const rxA = (await newDraft(doctorA, cidA)).body.data.id as string;
    await addLine(doctorA, rxA, 'MED-1001', 6, 3);
    const issued = await api('post', `/api/v1/doctor/prescriptions/${rxA}/issue`, doctorA);
    expect(issued.status).toBe(200);
    expect(issued.body.data.allergyCheck).toMatchObject({ policy: 'BLOCK', matches: [] });
  });

  it('issuance assigns a unique number and a 30-day validity; concurrent issues never collide', async () => {
    const cid = await consultation(doctorA, vikram, true);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const rxId = (await newDraft(doctorA, cid)).body.data.id as string;
      await addLine(doctorA, rxId, 'MED-1006', 2, 3);
      ids.push(rxId);
    }
    const results = await Promise.all(ids.map((id) => api('post', `/api/v1/doctor/prescriptions/${id}/issue`, doctorA)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const numbers = results.map((r) => r.body.data.rxNumber as string);
    expect(new Set(numbers).size).toBe(4);
    expect(numbers[0]).toMatch(/^CP-\d{4}-\d{6}$/);
    const issuedOn = new Date(results[0]!.body.data.issuedAt as string);
    const validTill = new Date(`${results[0]!.body.data.validTill as string}T00:00:00Z`);
    expect(Math.round((validTill.getTime() - issuedOn.getTime()) / 86_400_000)).toBeGreaterThanOrEqual(29);
  });

  it('issued prescriptions cannot be changed through the API or directly in the database', async () => {
    const cid = await consultation(doctorA, vikram, true);
    const rxId = (await newDraft(doctorA, cid)).body.data.id as string;
    const line = await addLine(doctorA, rxId, 'MED-1007', 2, 2);
    const itemId = line.body.data.items[0].id as string;
    expect((await api('post', `/api/v1/doctor/prescriptions/${rxId}/issue`, doctorA)).status).toBe(200);

    expect((await api('patch', `/api/v1/doctor/prescriptions/${rxId}/items/${itemId}`, doctorA, { quantity: 9 })).body.error.code).toBe('PRESCRIPTION_LOCKED');
    expect((await addLine(doctorA, rxId, 'MED-1005', 1, 1)).body.error.code).toBe('PRESCRIPTION_LOCKED');
    expect((await api('delete', `/api/v1/doctor/prescriptions/${rxId}/items/${itemId}`, doctorA)).body.error.code).toBe('PRESCRIPTION_LOCKED');
    expect((await api('patch', `/api/v1/doctor/prescriptions/${rxId}`, doctorA, { advice: 'changed' })).body.error.code).toBe('PRESCRIPTION_LOCKED');
    expect((await api('post', `/api/v1/doctor/prescriptions/${rxId}/issue`, doctorA)).body.error.code).toBe('ALREADY_ISSUED');

    await expect(db.query(`UPDATE prescriptions SET advice = 'silent edit' WHERE id = $1`, [rxId])).rejects.toThrow(/immutable/);
    await expect(db.query(`UPDATE prescription_items SET quantity = 50 WHERE prescription_id = $1`, [rxId])).rejects.toThrow(/draft/);
    await expect(db.query(`DELETE FROM prescriptions WHERE id = $1`, [rxId])).rejects.toThrow(/cannot be deleted/);
  });

  it('fulfilment happens once; a fulfilled prescription cannot be reused, replaced or reverted', async () => {
    const cid = await consultation(doctorA, vikram, true);
    const rxId = (await newDraft(doctorA, cid)).body.data.id as string;
    await addLine(doctorA, rxId, 'MED-1007', 2, 2);
    await api('post', `/api/v1/doctor/prescriptions/${rxId}/issue`, doctorA);

    await markFulfilled(db, rxId, { actorId: null });
    const seen = await api('get', `/api/v1/patients/me/prescriptions/${rxId}`, vikram);
    expect(seen.body.data.status).toBe('FULFILLED');
    await expect(markFulfilled(db, rxId, { actorId: null })).rejects.toMatchObject({ status: 409, code: 'ALREADY_FULFILLED' });
    await expect(getForPatient(db, vikram.id, rxId, new Date(Date.now() + 1)).then((v) => v.status)).resolves.toBe('FULFILLED');
    expect((await api('post', `/api/v1/doctor/prescriptions/${rxId}/replace`, doctorA)).body.error.code).toBe('NOT_REPLACEABLE');
    await expect(db.query(`UPDATE prescriptions SET status = 'ISSUED', fulfilled_at = NULL WHERE id = $1`, [rxId])).rejects.toThrow(/immutable/);
  });

  it('a correction is a replacement: the original is superseded only when the replacement is issued', async () => {
    const cid = await consultation(doctorA, vikram, true);
    const original = (await newDraft(doctorA, cid)).body.data.id as string;
    await addLine(doctorA, original, 'MED-1006', 2, 3);
    await api('post', `/api/v1/doctor/prescriptions/${original}/issue`, doctorA);

    const replacement = await api('post', `/api/v1/doctor/prescriptions/${original}/replace`, doctorA);
    expect(replacement.status).toBe(201);
    const newId = replacement.body.data.id as string;
    expect(replacement.body.data.items).toHaveLength(1);
    expect(replacement.body.data.replacesId).toBe(original);
    expect((await api('get', `/api/v1/patients/me/prescriptions/${original}`, vikram)).body.data.status).toBe('ISSUED');
    expect((await api('post', `/api/v1/doctor/prescriptions/${original}/replace`, doctorA)).body.error.code).toBe('REPLACEMENT_EXISTS');

    expect((await api('patch', `/api/v1/doctor/prescriptions/${newId}`, doctorA, { advice: 'Take with water' })).status).toBe(200);
    expect((await api('post', `/api/v1/doctor/prescriptions/${newId}/issue`, doctorA)).status).toBe(200);
    expect((await api('get', `/api/v1/patients/me/prescriptions/${original}`, vikram)).body.data.status).toBe('SUPERSEDED');
  });

  it('the patient sees own issued prescriptions with a PDF; drafts never appear; the PDF is a real PDF', async () => {
    const cid = await consultation(doctorA, anita, true);
    const rxId = (await newDraft(doctorA, cid)).body.data.id as string;
    await addLine(doctorA, rxId, 'MED-1001', 3, 3);
    await api('post', `/api/v1/doctor/prescriptions/${rxId}/issue`, doctorA);

    const list = await api('get', '/api/v1/patients/me/prescriptions', anita);
    expect(list.body.data.items.map((p: { id: string }) => p.id)).toContain(rxId);
    expect(list.body.data.items.every((p: { status: string }) => p.status !== 'DRAFT')).toBe(true);

    const pdf = await request(app).get(`/api/v1/patients/me/prescriptions/${rxId}/pdf`).set('Cookie', anita.cookie).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    expect((await request(app).get(`/api/v1/patients/me/prescriptions/${rxId}/pdf`).set('Cookie', vikram.cookie)).status).toBe(404);
    const draftId = (await newDraft(doctorA, cid)).body.data.id as string;
    expect((await api('get', `/api/v1/doctor/prescriptions/${draftId}/pdf`, doctorA)).body.error.code).toBe('NOT_ISSUED');
  });

  it('unauthorized access is refused: no session, wrong role, and a consent withdrawal stops issuance', async () => {
    const cid = await consultation(doctorA, vikram, true);
    const rxId = (await newDraft(doctorA, cid)).body.data.id as string;
    expect((await request(app).get(`/api/v1/doctor/prescriptions/${rxId}`)).status).toBe(401);
    expect((await api('get', `/api/v1/doctor/prescriptions/${rxId}`, vikram)).status).toBe(403);
    expect((await api('post', `/api/v1/doctor/consultations/${cid}/prescriptions`, vikram)).status).toBe(403);
    expect((await api('get', '/api/v1/patients/me/prescriptions', doctorA)).status).toBe(403);
    expect((await api('get', '/api/v1/medicines', vikram)).status).toBe(403);

    await addLine(doctorA, rxId, 'MED-1007', 1, 2);
    await api('post', '/api/v1/patients/me/consent', vikram, { granted: false });
    expect((await api('post', `/api/v1/doctor/prescriptions/${rxId}/issue`, doctorA)).body.error.code).toBe('CONSENT_WITHDRAWN');
    await api('post', '/api/v1/patients/me/consent', vikram, { granted: true });
  });

  it('the medicine search returns active catalogue entries with their allergy class', async () => {
    const r = await api('get', '/api/v1/medicines?query=amoxi', doctorA);
    expect(r.status).toBe(200);
    expect(r.body.data.items[0]).toMatchObject({ sku: 'MED-1002', allergyClass: 'Penicillin', rxRequired: true });
  });
});
