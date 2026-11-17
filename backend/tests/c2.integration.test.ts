import 'dotenv/config';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/common/logger.js';
import type { AuthLimits } from '../src/common/security/rateLimiter.js';
import { createDatabase, type Database } from '../src/infrastructure/database/pool.js';
import { buildApp, testHasher } from './helpers.js';

// Real-database tests against Neon. They run only when TEST_DATABASE_URL is set.
const url = process.env.TEST_DATABASE_URL;
const DOMAIN = '@carepulse-c2.invalid';
const PASSWORD = 'Strong@123';
const roomy: AuthLimits = { windowSec: 900, loginPerIp: 100_000, loginFailuresPerIdentifier: 100, registerPerIp: 100_000 };
const HOUR = 3_600_000;

interface Who {
  id: string;
  cookie: string;
  csrf: string;
}

const uniq = () => `${Date.now().toString(36)}${randomInt(1e6).toString(36)}`;
const mobile = () => `9${String(randomInt(0, 1e9)).padStart(9, '0')}`;
/** A time at minute 7: IST slot boundaries are on :00 and :30, so these never collide with generated slots. */
const atMinute7 = (msFromNow: number) => new Date(Math.floor((Date.now() + msFromNow) / 60_000) * 60_000 + 7 * 60_000);

describe.skipIf(!url)('C2: profile, consent, doctors and appointments (integration)', () => {
  let db: Database;
  let app: ReturnType<typeof buildApp>;
  let doctor: Who;
  let doctor2: Who;
  let inactiveDoctor: Who;
  let anita: Who; // patient with a penicillin allergy record
  let vikram: Who;
  let chandra: Who;
  let dev: Who; // never books anything

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

  async function makeDoctor(active: boolean): Promise<Who> {
    const email = `doc${uniq()}${DOMAIN}`;
    const u = await db.query<{ id: string }>(
      `INSERT INTO users (role, email, mobile, password_hash) VALUES ('DOCTOR', $1, $2, $3) RETURNING id`,
      [email, mobile(), await testHasher.hash(PASSWORD)],
    );
    const id = u.rows[0]!.id;
    await db.query(
      `INSERT INTO doctor_profiles (user_id, display_name, specialty, registration_no, experience_years, active)
       VALUES ($1, 'Dr Test', 'General Physician', $2, 10, $3)`,
      [id, `REG-${uniq()}`, active],
    );
    for (let weekday = 0; weekday <= 6; weekday++) {
      await db.query(
        `INSERT INTO doctor_availability (doctor_user_id, weekday, start_time, end_time, slot_minutes)
         VALUES ($1, $2, '09:00', '17:00', 30)`,
        [id, weekday],
      );
    }
    return login(email, id);
  }

  async function makePatient(): Promise<Who> {
    const email = `pat${uniq()}${DOMAIN}`;
    const r = await request(app).post('/api/v1/auth/register').send({
      fullName: 'Test Patient', email, mobile: mobile(), password: PASSWORD, dob: '1990-05-05', gender: 'FEMALE',
      bloodGroup: 'B+', addressLine: '12 Test Lane', city: 'Pune', state: 'Maharashtra', pincode: '411001',
      emergencyContactName: 'Next Kin', emergencyContactPhone: mobile(), consent: true,
    });
    return { id: r.body.data.user.id as string, cookie: cookieOf(r), csrf: r.body.data.csrfToken as string };
  }

  async function insertSlot(doctorId: string, startsAt: Date, status = 'OPEN'): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO appointment_slots (doctor_user_id, starts_at, ends_at, status)
       VALUES ($1, $2, $2::timestamptz + interval '30 minutes', $3) RETURNING id`,
      [doctorId, startsAt.toISOString(), status],
    );
    return r.rows[0]!.id;
  }

  /** First future slot the API offers that nobody holds yet. Uses the real listing endpoint. */
  async function openSlot(doc: Who): Promise<string> {
    const r = await api('get', `/api/v1/doctors/${doc.id}/slots?days=3`, anita);
    const slot = (r.body.data.slots as { id: string; booked: boolean; startsAt: string }[]).find(
      (s) => !s.booked && Date.parse(s.startsAt) > Date.now() + 2 * HOUR,
    );
    if (!slot) throw new Error('no open slot found');
    return slot.id;
  }

  const bookBody = (slotId: string) => ({
    slotId, chiefComplaint: 'Fever and cough', symptoms: ['fever', 'cough'], durationDays: 3, severity: 'MODERATE',
  });

  beforeAll(async () => {
    db = createDatabase({ connectionString: url as string, max: 6, logger: createLogger('silent') });
    app = buildApp(db, { limits: roomy });
    doctor = await makeDoctor(true);
    doctor2 = await makeDoctor(true);
    inactiveDoctor = await makeDoctor(false);
    anita = await makePatient();
    vikram = await makePatient();
    chandra = await makePatient();
    dev = await makePatient();
  });

  afterAll(async () => {
    const doctorIds = [doctor, doctor2, inactiveDoctor].map((d) => d.id);
    const patientIds = [anita, vikram, chandra, dev].map((p) => p.id);
    const everyone = [...doctorIds, ...patientIds];
    await db.query('DELETE FROM appointments WHERE doctor_user_id = ANY($1::uuid[])', [everyone]);
    await db.query('DELETE FROM appointment_slots WHERE doctor_user_id = ANY($1::uuid[])', [everyone]);
    await db.query('DELETE FROM doctor_availability WHERE doctor_user_id = ANY($1::uuid[])', [everyone]);
    await db.query('DELETE FROM health_info WHERE patient_user_id = ANY($1::uuid[])', [everyone]);
    await db.query('DELETE FROM patient_medications WHERE patient_user_id = ANY($1::uuid[])', [everyone]);
    await db.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [everyone]);
    await db.query('DELETE FROM patient_profiles WHERE user_id = ANY($1::uuid[])', [everyone]);
    await db.query('DELETE FROM doctor_profiles WHERE user_id = ANY($1::uuid[])', [everyone]);
    await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [everyone]);
    await db.close();
  });

  it('profile: patients view and edit only their own profile; a bad or extra-field edit is rejected', async () => {
    const me = await api('get', '/api/v1/patients/me', anita);
    expect(me.status).toBe(200);
    expect(me.body.data.profile.age).toBeGreaterThan(30);

    const edit = { ...me.body.data.profile, city: 'Mumbai', pincode: '400001', dob: '1990-05-05' };
    const body = {
      fullName: edit.fullName, dob: edit.dob, gender: edit.gender, bloodGroup: edit.bloodGroup, addressLine: edit.addressLine,
      city: 'Mumbai', state: edit.state, pincode: '400001',
      emergencyContactName: edit.emergencyContactName, emergencyContactPhone: edit.emergencyContactPhone,
    };
    expect((await api('put', '/api/v1/patients/me', anita, body)).status).toBe(200);

    // Vikram's edit goes to Vikram's record only (there is no id in the route to target someone else).
    await api('put', '/api/v1/patients/me', vikram, { ...body, city: 'Delhi' });
    const anitaNow = await api('get', '/api/v1/patients/me', anita);
    expect(anitaNow.body.data.profile.city).toBe('Mumbai');

    expect((await api('put', '/api/v1/patients/me', anita, { ...body, pincode: '12' })).status).toBe(422);
    expect((await api('put', '/api/v1/patients/me', anita, { ...body, age: 99 })).status).toBe(422);
    expect((await api('get', '/api/v1/patients/me')).status).toBe(401);
  });

  it('consent: new health data is refused without consent; withdrawal and re-grant are explicit', async () => {
    expect((await api('post', '/api/v1/patients/me/consent', anita, {})).status).toBe(422);
    const withdraw = await api('post', '/api/v1/patients/me/consent', anita, { granted: false });
    expect(withdraw.body.data).toMatchObject({ consentStatus: false });
    expect(withdraw.body.data.consentWithdrawnAt).not.toBeNull();

    const refused = await api('post', '/api/v1/patients/me/health-info', anita, {
      type: 'CONDITION', name: 'Mild asthma', severity: 'MILD', notedOn: '2020-01-01',
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('CONSENT_REQUIRED');

    const grant = await api('post', '/api/v1/patients/me/consent', anita, { granted: true });
    expect(grant.body.data).toMatchObject({ consentStatus: true, consentWithdrawnAt: null });
  });

  it('health context: structured allergies and conditions, duplicates refused, cross-patient edits blocked', async () => {
    const allergy = await api('post', '/api/v1/patients/me/health-info', anita, {
      type: 'ALLERGY', name: 'Penicillin', allergyClass: 'Penicillin', severity: 'SEVERE', notedOn: '2015-03-10',
    });
    expect(allergy.status).toBe(201);
    expect((await api('post', '/api/v1/patients/me/health-info', anita, {
      type: 'ALLERGY', name: 'penicillin', allergyClass: 'Penicillin', notedOn: '2015-03-10',
    })).status).toBe(409);
    expect((await api('post', '/api/v1/patients/me/health-info', anita, {
      type: 'CONDITION', name: 'Mild asthma', allergyClass: 'Respiratory', notedOn: '2020-01-01',
    })).status).toBe(422);
    expect((await api('post', '/api/v1/patients/me/health-info', anita, {
      type: 'CONDITION', name: 'Mild asthma', severity: 'MILD', notedOn: '2020-01-01',
    })).status).toBe(201);

    const allergies = await api('get', '/api/v1/patients/me/health-info?type=ALLERGY', anita);
    expect(allergies.body.data.items).toHaveLength(1);
    expect(allergies.body.data.meta.total).toBe(1);

    const recordId = allergy.body.data.id as string;
    expect((await api('patch', `/api/v1/patients/me/health-info/${recordId}`, vikram, { severity: 'MILD' })).status).toBe(404);
    expect((await api('patch', `/api/v1/patients/me/health-info/${recordId}`, anita, { severity: 'MODERATE' })).status).toBe(200);

    const med = await api('post', '/api/v1/patients/me/medications', anita, {
      medicationName: 'Salbutamol inhaler', dose: '100 mcg', frequency: 'as needed', startedOn: '2025-01-01',
    });
    expect(med.status).toBe(201);
    const stopped = await api('patch', `/api/v1/patients/me/medications/${med.body.data.id as string}`, anita, { active: false });
    expect(stopped.body.data).toMatchObject({ active: false });
    expect(stopped.body.data.endedOn).not.toBeNull();
  });

  it('directory and slots: public fields only; inactive doctors are invisible; slots are future-only', async () => {
    const list = await api('get', '/api/v1/doctors?query=Dr', anita);
    expect(list.status).toBe(200);
    const ids = (list.body.data.items as { id: string }[]).map((d) => d.id);
    expect(ids).toContain(doctor.id);
    expect(ids).not.toContain(inactiveDoctor.id);
    expect(JSON.stringify(list.body)).not.toMatch(/registrationNo|REG-|@carepulse|mobile/i);

    expect((await api('get', `/api/v1/doctors/${inactiveDoctor.id}`, anita)).status).toBe(404);
    const slots = await api('get', `/api/v1/doctors/${doctor.id}/slots?days=2`, anita);
    expect(slots.body.data.slots.length).toBeGreaterThan(0);
    expect((slots.body.data.slots as { startsAt: string }[]).every((s) => Date.parse(s.startsAt) > Date.now())).toBe(true);
  });

  let firstAppointmentId = '';
  it('booking: valid booking; rejects injected owner fields, past, disabled, inactive-doctor, consent-less and taken slots', async () => {
    const slotId = await openSlot(doctor);
    const ok = await api('post', '/api/v1/appointments', anita, bookBody(slotId));
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ status: 'REQUESTED', booking: { feeInr: 100, feeStatus: 'SIMULATED_HELD' } });
    firstAppointmentId = ok.body.data.id as string;

    expect((await api('post', '/api/v1/appointments', vikram, { ...bookBody(slotId), patientId: vikram.id })).status).toBe(422);
    const taken = await api('post', '/api/v1/appointments', vikram, bookBody(slotId));
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('SLOT_TAKEN');

    const past = await insertSlot(doctor.id, atMinute7(-HOUR));
    expect((await api('post', '/api/v1/appointments', vikram, bookBody(past))).body.error.code).toBe('PAST_SLOT');
    const disabled = await insertSlot(doctor.id, atMinute7(5 * 24 * HOUR), 'DISABLED');
    expect((await api('post', '/api/v1/appointments', vikram, bookBody(disabled))).body.error.code).toBe('SLOT_UNAVAILABLE');
    const inactive = await insertSlot(inactiveDoctor.id, atMinute7(3 * 24 * HOUR));
    expect((await api('post', '/api/v1/appointments', vikram, bookBody(inactive))).body.error.code).toBe('DOCTOR_UNAVAILABLE');
    expect((await api('post', '/api/v1/appointments', vikram, bookBody('6f1c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6'))).status).toBe(404);

    await api('post', '/api/v1/patients/me/consent', dev, { granted: false });
    const devSlot = await insertSlot(doctor.id, atMinute7(4 * 24 * HOUR));
    const noConsent = await api('post', '/api/v1/appointments', dev, bookBody(devSlot));
    expect(noConsent.body.error.code).toBe('CONSENT_REQUIRED');
  });

  it('concurrency: six simultaneous bookings of one slot produce exactly one appointment', async () => {
    const slot = await insertSlot(doctor2.id, atMinute7(6 * 24 * HOUR));
    const attempts = [vikram, chandra, anita, vikram, chandra, anita];
    const results = await Promise.all(attempts.map((who) => api('post', '/api/v1/appointments', who, bookBody(slot))));
    const created = results.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const rows = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM appointments WHERE slot_id = $1 AND status IN ('REQUESTED','CONFIRMED','COMPLETED')`,
      [slot],
    );
    expect(rows.rows[0]!.n).toBe(1);
  });

  it('cancellation and rescheduling follow the 2-hour rule and respect ownership', async () => {
    const late = await insertSlot(doctor.id, atMinute7(HOUR)); // 1 hour away: inside the window
    const lateBooking = await api('post', '/api/v1/appointments', vikram, bookBody(late));
    const lateId = lateBooking.body.data.id as string;
    expect((await api('post', `/api/v1/appointments/${lateId}/cancel`, anita, {})).status).toBe(404); // not hers
    const cancelled = await api('post', `/api/v1/appointments/${lateId}/cancel`, vikram, { reason: 'Feeling better' });
    expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', booking: { feeStatus: 'SIMULATED_FORFEITED' } });
    expect(cancelled.body.data.cancellation).toMatchObject({ by: 'PATIENT' });
    expect((await api('post', `/api/v1/appointments/${lateId}/cancel`, vikram, {})).body.error.code).toBe('INVALID_TRANSITION');

    const far = await insertSlot(doctor.id, atMinute7(6 * HOUR));
    const farBooking = await api('post', '/api/v1/appointments', chandra, bookBody(far));
    const farId = farBooking.body.data.id as string;
    const target = await insertSlot(doctor.id, atMinute7(8 * HOUR));
    const moved = await api('patch', `/api/v1/appointments/${farId}/reschedule`, chandra, { slotId: target });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ rescheduledCount: 1 });
    const oldSlotHolders = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM appointments WHERE slot_id = $1 AND status IN ('REQUESTED','CONFIRMED')`, [far],
    );
    expect(oldSlotHolders.rows[0]!.n).toBe(0);

    const otherDoctor = await insertSlot(doctor2.id, atMinute7(9 * HOUR));
    expect((await api('patch', `/api/v1/appointments/${farId}/reschedule`, chandra, { slotId: otherDoctor })).body.error.code).toBe('DIFFERENT_DOCTOR');

    expect((await api('patch', `/api/v1/appointments/${farId}/reschedule`, anita, { slotId: far })).status).toBe(404);

    // Inside 2 hours of the current slot, rescheduling is refused.
    const near = await insertSlot(doctor.id, atMinute7(1.5 * HOUR));
    const nearId = (await api('post', '/api/v1/appointments', chandra, bookBody(near))).body.data.id as string;
    const nearTarget = await insertSlot(doctor.id, atMinute7(10 * HOUR));
    expect((await api('patch', `/api/v1/appointments/${nearId}/reschedule`, chandra, { slotId: nearTarget })).body.error.code).toBe('RESCHEDULE_WINDOW_CLOSED');

    const released = await api('post', `/api/v1/appointments/${farId}/cancel`, chandra, {});
    expect(released.body.data.booking.feeStatus).toBe('SIMULATED_RELEASED');

    const mine = await api('get', '/api/v1/appointments/me?scope=past', chandra);
    expect(mine.body.data.items.map((a: { id: string }) => a.id)).toContain(farId);
  });

  it('doctors see only their own patients; consent withdrawal stops sharing with doctors', async () => {
    const mine = await api('get', '/api/v1/doctor/appointments', doctor);
    const ids = (mine.body.data.items as { id: string }[]).map((a) => a.id);
    expect(ids).toContain(firstAppointmentId);
    const other = await api('get', '/api/v1/doctor/appointments', doctor2);
    expect((other.body.data.items as { id: string }[]).map((a) => a.id)).not.toContain(firstAppointmentId);

    const context = await api('get', `/api/v1/doctor/patients/${anita.id}/context`, doctor);
    expect(context.status).toBe(200);
    expect(context.body.data.allergies[0]).toMatchObject({ name: 'Penicillin', severity: 'MODERATE' });
    expect(JSON.stringify(context.body)).not.toMatch(/addressLine|@carepulse|emergency/i);
    expect((await api('get', `/api/v1/doctor/patients/${dev.id}/context`, doctor)).status).toBe(404);
    expect((await api('get', `/api/v1/doctor/patients/${anita.id}/context`, anita)).status).toBe(403);

    expect((await api('patch', `/api/v1/doctor/appointments/${firstAppointmentId}/status`, doctor, { status: 'CONFIRMED' })).body.data.status).toBe('CONFIRMED');
    expect((await api('patch', `/api/v1/doctor/appointments/${firstAppointmentId}/status`, doctor, { status: 'CANCELLED' })).status).toBe(422);
    expect((await api('patch', `/api/v1/doctor/appointments/${firstAppointmentId}/status`, doctor, { status: 'COMPLETED' })).body.error.code).toBe('TOO_EARLY');
    expect((await api('patch', `/api/v1/doctor/appointments/${firstAppointmentId}/status`, doctor2, { status: 'CONFIRMED' })).status).toBe(404);

    await api('post', '/api/v1/patients/me/consent', anita, { granted: false });
    const withdrawn = await api('get', `/api/v1/doctor/patients/${anita.id}/context`, doctor);
    expect(withdrawn.status).toBe(403);
    expect(withdrawn.body.error.code).toBe('CONSENT_WITHDRAWN');
    const afterWithdrawal = await api('get', '/api/v1/doctor/appointments', doctor);
    expect((afterWithdrawal.body.data.items as { id: string }[]).map((a) => a.id)).not.toContain(firstAppointmentId);

    const audit = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE entity_id = $1`, [firstAppointmentId],
    );
    expect(audit.rows[0]!.n).toBeGreaterThanOrEqual(2);
  });
});
