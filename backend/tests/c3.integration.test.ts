import 'dotenv/config';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/common/logger.js';
import type { AuthLimits } from '../src/common/security/rateLimiter.js';
import { createDatabase, type Database } from '../src/infrastructure/database/pool.js';
import { buildApp, testHasher } from './helpers.js';

// Real-database tests against Neon. Finalized consultations are immutable by design, so these rows
// cannot be deleted afterwards. They are tagged with the test domain below.
const url = process.env.TEST_DATABASE_URL;
const DOMAIN = '@carepulse-c3.invalid';
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

describe.skipIf(!url)('C3: doctor workspace, consultations and immutability (integration)', () => {
  let db: Database;
  let app: ReturnType<typeof buildApp>;
  let doctorA: Who;
  let doctorB: Who;
  let patientP: Who; // has a red-flag appointment with doctor A
  let patientQ: Who; // routine appointment with doctor A
  let patientR: Who; // no relationship with doctor A
  let apptP = '';
  let apptQ = '';
  let consultationId = '';

  const cookieOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[] | undefined)?.[0]?.split(';')[0] ?? '';
  const api = (method: 'get' | 'post' | 'put' | 'patch', path: string, who?: Who, body?: object) => {
    const agent = request(app);
    let t = method === 'get' ? agent.get(path) : method === 'post' ? agent.post(path) : method === 'put' ? agent.put(path) : agent.patch(path);
    if (who) t = t.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrf);
    return body !== undefined ? t.send(body) : t;
  };

  async function login(email: string, id: string): Promise<Who> {
    const r = await request(app).post('/api/v1/auth/login').send({ identifier: email, password: PASSWORD });
    return { id, cookie: cookieOf(r), csrf: r.body.data.csrfToken as string };
  }

  async function makeDoctor(): Promise<Who> {
    const email = `doc${uniq()}${DOMAIN}`;
    const u = await db.query<{ id: string }>(
      `INSERT INTO users (role, email, mobile, password_hash) VALUES ('DOCTOR', $1, $2, $3) RETURNING id`,
      [email, mobile(), await testHasher.hash(PASSWORD)],
    );
    const id = u.rows[0]!.id;
    await db.query(
      `INSERT INTO doctor_profiles (user_id, display_name, specialty, registration_no, experience_years)
       VALUES ($1, 'Dr Clinic', 'General Physician', $2, 9)`,
      [id, `REG-${uniq()}`],
    );
    return login(email, id);
  }

  async function makePatient(): Promise<Who> {
    const email = `pat${uniq()}${DOMAIN}`;
    const r = await request(app).post('/api/v1/auth/register').send({
      fullName: 'Chart Patient', email, mobile: mobile(), password: PASSWORD, dob: '1985-02-02', gender: 'MALE',
      bloodGroup: 'O+', addressLine: '5 Chart Street', city: 'Pune', state: 'Maharashtra', pincode: '411002',
      emergencyContactName: 'Kin Person', emergencyContactPhone: mobile(), consent: true,
    });
    return { id: r.body.data.user.id as string, cookie: cookieOf(r), csrf: r.body.data.csrfToken as string };
  }

  /** A slot a few minutes ahead, off the IST half-hour grid so it never collides with generated slots. */
  async function nearSlot(doctorId: string, minutesAhead: number): Promise<string> {
    const at = new Date(Date.now() + minutesAhead * MIN + 1234);
    const r = await db.query<{ id: string }>(
      `INSERT INTO appointment_slots (doctor_user_id, starts_at, ends_at)
       VALUES ($1, $2, $2::timestamptz + interval '30 minutes') RETURNING id`,
      [doctorId, at.toISOString()],
    );
    return r.rows[0]!.id;
  }

  const booking = (slotId: string, complaint: string) => ({
    slotId, chiefComplaint: complaint, symptoms: ['fever'], durationDays: 2, severity: 'MODERATE',
  });

  const fullDraft = {
    chiefComplaint: 'Fever for two days',
    examinationNotes: 'Throat mildly red; chest clear.',
    diagnosisDescription: 'Viral fever (provisional, clinician judgement)',
    severity: 'MODERATE',
    followUpOn: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    vitals: { bpSystolic: 118, bpDiastolic: 76, pulse: 88, temperatureC: 38.4, spo2: 97 },
  };

  beforeAll(async () => {
    db = createDatabase({ connectionString: url as string, max: 4, logger: createLogger('silent') });
    app = buildApp(db, { limits: roomy });
    doctorA = await makeDoctor();
    doctorB = await makeDoctor();
    patientP = await makePatient();
    patientQ = await makePatient();
    patientR = await makePatient();

    const slotP = await nearSlot(doctorA.id, 5);
    const slotQ = await nearSlot(doctorA.id, 6);
    const bookedP = await api('post', '/api/v1/appointments', patientP, booking(slotP, 'Crushing chest pain since this morning'));
    const bookedQ = await api('post', '/api/v1/appointments', patientQ, booking(slotQ, 'Routine fever check'));
    apptP = bookedP.body.data.id as string;
    apptQ = bookedQ.body.data.id as string;
    await api('patch', `/api/v1/doctor/appointments/${apptP}/status`, doctorA, { status: 'CONFIRMED' });
    await api('patch', `/api/v1/doctor/appointments/${apptQ}/status`, doctorA, { status: 'CONFIRMED' });
  });

  it('escalation: a red-flag booking is marked and listed first for the doctor, with guidance for the patient', async () => {
    const mine = await api('get', '/api/v1/doctor/appointments?from=2000-01-01&to=2100-01-01&pageSize=100', doctorA);
    expect(mine.status).toBe(200);
    const items = mine.body.data.items as { id: string; escalated: boolean; emergencyGuidance: string | null }[];
    const pIndex = items.findIndex((a) => a.id === apptP);
    const qIndex = items.findIndex((a) => a.id === apptQ);
    expect(items[pIndex]).toMatchObject({ escalated: true });
    expect(items[pIndex]!.emergencyGuidance).toMatch(/emergency number/);
    expect(items[qIndex]!.escalated).toBe(false);
    expect(pIndex).toBeLessThan(qIndex);
  });

  it('a doctor sees only permitted appointments and cannot open another doctor\'s or an unrelated patient\'s record', async () => {
    expect((await api('get', `/api/v1/doctor/appointments/${apptP}`, doctorA)).body.data.appointment.id).toBe(apptP);
    expect((await api('get', `/api/v1/doctor/appointments/${apptP}`, doctorB)).status).toBe(404);
    expect((await api('post', `/api/v1/doctor/appointments/${apptP}/consultation`, doctorB)).status).toBe(404);
    expect((await api('get', `/api/v1/doctor/patients/${patientR.id}/history`, doctorA)).status).toBe(404);
    expect((await api('get', `/api/v1/doctor/patients/${patientP.id}/history`, doctorB)).status).toBe(404);
  });

  it('opens a draft once (idempotent) and refuses patients and other roles', async () => {
    expect((await api('post', `/api/v1/doctor/appointments/${apptP}/consultation`, patientP)).status).toBe(403);
    expect((await api('get', `/api/v1/doctor/consultations/${consultationId || '6f1c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6'}`, patientP)).status).toBe(403);
    expect((await api('get', `/api/v1/doctor/appointments/${apptP}`)).status).toBe(401);

    const first = await api('post', `/api/v1/doctor/appointments/${apptP}/consultation`, doctorA);
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ status: 'DRAFT', patient: { id: patientP.id }, doctor: { id: doctorA.id } });
    consultationId = first.body.data.id as string;
    const again = await api('post', `/api/v1/doctor/appointments/${apptP}/consultation`, doctorA);
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(consultationId);
  });

  it('patients cannot write diagnoses; invalid vitals are rejected with field detail', async () => {
    expect((await api('put', `/api/v1/doctor/consultations/${consultationId}`, patientP, fullDraft)).status).toBe(403);

    for (const vitals of [
      { ...fullDraft.vitals, bpSystolic: 70, bpDiastolic: 110 },
      { ...fullDraft.vitals, spo2: 101 },
      { ...fullDraft.vitals, temperatureC: 38.45 },
      { ...fullDraft.vitals, bpSystolic: 120, bpDiastolic: null },
    ]) {
      const res = await api('put', `/api/v1/doctor/consultations/${consultationId}`, doctorA, { ...fullDraft, vitals });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('saves a valid draft, then refuses to finalize while required content is missing', async () => {
    const saved = await api('put', `/api/v1/doctor/consultations/${consultationId}`, doctorA, fullDraft);
    expect(saved.status).toBe(200);
    expect(saved.body.data.vitals).toMatchObject({ pulse: 88, spo2: 97 });
    expect(saved.body.data.diagnosis).toEqual({ description: fullDraft.diagnosisDescription, coded: false });

    await api('put', `/api/v1/doctor/consultations/${consultationId}`, doctorA, { ...fullDraft, diagnosisDescription: null });
    const incomplete = await api('post', `/api/v1/doctor/consultations/${consultationId}/finalize`, doctorA);
    expect(incomplete.status).toBe(422);
    expect(incomplete.body.error.details).toContainEqual(expect.objectContaining({ path: 'diagnosis.description' }));
    await api('put', `/api/v1/doctor/consultations/${consultationId}`, doctorA, fullDraft);
  });

  it('finalizes once; the record and its vitals become immutable and the appointment is completed', async () => {
    const fin = await api('post', `/api/v1/doctor/consultations/${consultationId}/finalize`, doctorA);
    expect(fin.status).toBe(200);
    expect(fin.body.data).toMatchObject({ status: 'FINALIZED' });
    expect(fin.body.data.finalizedAt).not.toBeNull();

    expect((await api('put', `/api/v1/doctor/consultations/${consultationId}`, doctorA, { ...fullDraft, chiefComplaint: 'Changed later' })).body.error.code).toBe('CONSULTATION_FINALIZED');
    expect((await api('post', `/api/v1/doctor/consultations/${consultationId}/finalize`, doctorA)).body.error.code).toBe('ALREADY_FINALIZED');
    expect((await api('get', `/api/v1/doctor/appointments/${apptP}`, doctorA)).body.data.appointment.status).toBe('COMPLETED');

    await expect(db.query(`UPDATE consultations SET chief_complaint = 'silent edit' WHERE id = $1`, [consultationId])).rejects.toThrow(/immutable/);
    await expect(db.query(`UPDATE vitals SET pulse = 200 WHERE consultation_id = $1`, [consultationId])).rejects.toThrow(/draft/);
    await expect(db.query(`DELETE FROM consultations WHERE id = $1`, [consultationId])).rejects.toThrow(/cannot be deleted/);
    await expect(
      db.query(`INSERT INTO vitals (consultation_id, pulse) VALUES ($1, 70)`, [consultationId]),
    ).rejects.toThrow(/draft/);
  });

  it('corrections are addenda: the original is preserved and addenda are append-only', async () => {
    expect((await api('post', `/api/v1/doctor/consultations/${consultationId}/addenda`, doctorB, { content: 'Not my patient' })).status).toBe(404);
    expect((await api('post', `/api/v1/doctor/consultations/${consultationId}/addenda`, patientP, { content: 'Patient correction' })).status).toBe(403);

    const added = await api('post', `/api/v1/doctor/consultations/${consultationId}/addenda`, doctorA, { content: 'Repeat temperature 38.9 at follow-up' });
    expect(added.status).toBe(201);
    expect(added.body.data.addenda).toHaveLength(1);
    expect(added.body.data.chiefComplaint).toBe(fullDraft.chiefComplaint);
    expect(added.body.data.vitals).toMatchObject({ temperatureC: 38.4 });

    const addendumId = added.body.data.addenda[0].id as string;
    await expect(db.query(`UPDATE consultation_addenda SET content = 'x' WHERE id = $1`, [addendumId])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM consultation_addenda WHERE id = $1`, [addendumId])).rejects.toThrow(/append-only/);
  });

  it('consultations are bound to the right appointment, patient and doctor at the database level', async () => {
    await expect(
      db.query(`INSERT INTO consultations (appointment_id, patient_user_id, doctor_user_id) VALUES ($1, $2, $3)`, [apptQ, patientR.id, doctorA.id]),
    ).rejects.toThrow(/consultations_appointment_fk|foreign key/);
  });

  it('patients see only their own finalized visits, with addenda; drafts never appear', async () => {
    const visits = await api('get', '/api/v1/patients/me/visits', patientP);
    expect(visits.status).toBe(200);
    expect(visits.body.data.items).toHaveLength(1);
    expect(visits.body.data.items[0]).toMatchObject({ diagnosis: { description: fullDraft.diagnosisDescription }, severity: 'MODERATE' });
    expect(visits.body.data.items[0].addenda).toHaveLength(1);
    expect((await api('get', '/api/v1/patients/me/visits', patientQ)).body.data.items).toHaveLength(0);
  });

  it('the treating doctor sees the history; consent withdrawal blocks it and the chart, but not the patient', async () => {
    const history = await api('get', `/api/v1/doctor/patients/${patientP.id}/history`, doctorA);
    expect(history.status).toBe(200);
    expect(history.body.data.items).toHaveLength(1);

    await api('post', '/api/v1/patients/me/consent', patientP, { granted: false });
    expect((await api('get', `/api/v1/doctor/consultations/${consultationId}`, doctorA)).body.error.code).toBe('CONSENT_WITHDRAWN');
    expect((await api('get', `/api/v1/doctor/patients/${patientP.id}/history`, doctorA)).body.error.code).toBe('CONSENT_WITHDRAWN');
    expect((await api('get', '/api/v1/patients/me/visits', patientP)).status).toBe(200);
    await api('post', '/api/v1/patients/me/consent', patientP, { granted: true });
  });
});
