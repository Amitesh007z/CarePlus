import 'dotenv/config';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/common/logger.js';
import type { AuthLimits } from '../src/common/security/rateLimiter.js';
import { createDatabase, type Database } from '../src/infrastructure/database/pool.js';
import type { Role } from '../src/modules/auth/session.service.js';
import { buildApp, TEST_ORIGIN, testHasher } from './helpers.js';

// Real-database integration tests (Neon). Skipped unless TEST_DATABASE_URL is set.
const url = process.env.TEST_DATABASE_URL;
const DOMAIN = '@carepulse-test.invalid';
const PASSWORD = 'Strong@123';
const roomy: AuthLimits = { windowSec: 900, loginPerIp: 10_000, loginFailuresPerIdentifier: 5, registerPerIp: 10_000 };

const uniq = () => `${Date.now().toString(36)}${randomInt(1e6).toString(36)}`;
const mobile = () => `9${String(randomInt(0, 1e9)).padStart(9, '0')}`;

const payload = (over: Record<string, unknown> = {}) => ({
  fullName: 'Test Person', email: `t${uniq()}${DOMAIN}`, mobile: mobile(), password: PASSWORD, dob: '1992-03-04',
  gender: 'FEMALE', bloodGroup: 'A+', addressLine: '12 Test Lane', city: 'Pune', state: 'Maharashtra',
  pincode: '411001', emergencyContactName: 'Kin', emergencyContactPhone: mobile(), consent: true, ...over,
});

describe.skipIf(!url)('auth (integration)', () => {
  let db: Database;
  let app: ReturnType<typeof buildApp>;

  const cleanup = async () => {
    await db.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${DOMAIN}`]);
    for (const t of ['patient_profiles', 'doctor_profiles', 'pharmacist_profiles', 'admin_profiles']) {
      await db.query(`DELETE FROM ${t} WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${DOMAIN}`]);
    }
    await db.query('DELETE FROM users WHERE email LIKE $1', [`%${DOMAIN}`]);
    await db.query(`DELETE FROM rate_limits WHERE key LIKE '%:ip:%' OR key LIKE 'login:id:%'`);
  };

  beforeAll(async () => {
    db = createDatabase({ connectionString: url as string, max: 5, logger: createLogger('silent') });
    app = buildApp(db, { limits: roomy });
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await db.close();
  });

  const cookieOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[] | undefined)?.[0] ?? '';
  const sessionCookie = (res: request.Response) => cookieOf(res).split(';')[0]!;

  async function register(over: Record<string, unknown> = {}) {
    const body = payload(over);
    const res = await request(app).post('/api/v1/auth/register').send(body);
    return { res, body };
  }

  /** Creates a user of any role directly in the DB (staff accounts are never created via the public API). */
  async function staff(role: Role) {
    const email = `${role.toLowerCase()}${uniq()}${DOMAIN}`;
    const hash = await testHasher.hash(PASSWORD);
    const u = await db.query<{ id: string }>(
      'INSERT INTO users (role, email, mobile, password_hash) VALUES ($1,$2,$3,$4) RETURNING id',
      [role, email, mobile(), hash],
    );
    const id = u.rows[0]!.id;
    if (role === 'DOCTOR') {
      await db.query(`INSERT INTO doctor_profiles (user_id, display_name, specialty, registration_no, experience_years) VALUES ($1,'Dr Test','GP',$2,3)`, [id, `REG-${uniq()}`]);
    } else if (role === 'PHARMACIST') {
      await db.query(`INSERT INTO pharmacist_profiles (user_id, display_name) VALUES ($1,'Pharm Test')`, [id]);
    } else if (role === 'ADMIN') {
      await db.query(`INSERT INTO admin_profiles (user_id, display_name) VALUES ($1,'Admin Test')`, [id]);
    }
    return email;
  }

  async function login(email: string, password = PASSWORD, agentApp = app) {
    return request(agentApp).post('/api/v1/auth/login').send({ identifier: email, password });
  }

  describe('registration', () => {
    it('creates a PATIENT, normalizes input, sets an HttpOnly cookie and hides secrets', async () => {
      const { res, body } = await register({ email: `  T${uniq()}${DOMAIN.toUpperCase()} `, mobile: '+91 ' + mobile() });
      expect(res.status).toBe(201);
      expect(res.body.data.user).toMatchObject({ role: 'PATIENT', displayName: 'Test Person' });
      expect(res.body.data.user.patient).toMatchObject({ consentStatus: true, bloodGroup: 'A+' });
      expect(res.body.data.user.patient.age).toBeGreaterThan(20);
      expect(typeof res.body.data.csrfToken).toBe('string');
      const cookie = cookieOf(res);
      expect(cookie).toMatch(/^cp_sid=/);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).not.toMatch(/Secure/i); // local dev only; see production test below
      expect(JSON.stringify(res.body)).not.toMatch(/password|argon2|token_hash/i);
      const row = await db.query('SELECT role, email, mobile, password_hash FROM users WHERE lower(email) = lower($1)', [res.body.data.user.email]);
      expect(row.rows[0]).toMatchObject({ role: 'PATIENT' });
      expect(row.rows[0]!.email).toBe(res.body.data.user.email.toLowerCase());
      expect(row.rows[0]!.mobile).toMatch(/^[6-9]\d{9}$/);
      expect(row.rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
      expect(body.password).not.toBe(row.rows[0]!.password_hash);
    });

    it('rejects duplicate email (any case) and duplicate mobile (any format) with 409', async () => {
      const first = await register();
      const dupEmail = await register({ email: first.body.email.toUpperCase() });
      expect(dupEmail.res.status).toBe(409);
      expect(dupEmail.res.body.error.details[0].path).toBe('email');
      const dupMobile = await register({ mobile: `+91-${first.body.mobile}` });
      expect(dupMobile.res.status).toBe(409);
      expect(dupMobile.res.body.error.details[0].path).toBe('mobile');
    });

    it('lets exactly one of several concurrent duplicate registrations win', async () => {
      const email = `race${uniq()}${DOMAIN}`;
      const results = await Promise.all([1, 2, 3, 4].map(() => register({ email })));
      const statuses = results.map((r) => r.res.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409]);
      const count = await db.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [email]);
      expect(count.rows[0]!.n).toBe(1);
    });

    it('returns 422 with field details for invalid input', async () => {
      for (const patch of [{ password: 'weak' }, { email: 'bad' }, { mobile: '123' }, { pincode: '12' }, { consent: false }]) {
        const { res } = await register(patch);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.details.length).toBeGreaterThan(0);
      }
    });

    it('cannot be used to create privileged users', async () => {
      for (const role of ['ADMIN', 'DOCTOR', 'PHARMACIST']) {
        const { res, body } = await register({ role });
        expect(res.status).toBe(422);
        const n = await db.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [body.email]);
        expect(n.rows[0]!.n).toBe(0);
      }
    });
  });

  describe('login, sessions and logout', () => {
    it('logs in by email or by mobile, and /me restores the session after a "refresh"', async () => {
      const { body } = await register();
      const byEmail = await login(body.email.toUpperCase());
      expect(byEmail.status).toBe(200);
      const byMobile = await login(`+91 ${body.mobile}`);
      expect(byMobile.status).toBe(200);

      // "Refresh": a brand-new client presenting only the cookie.
      const me = await request(app).get('/api/v1/auth/me').set('Cookie', sessionCookie(byMobile));
      expect(me.status).toBe(200);
      expect(me.body.data.user.email).toBe(body.email);
      expect(me.body.data.csrfToken).toBe(byMobile.body.data.csrfToken);
    });

    it('fails generically: wrong password and unknown account are indistinguishable', async () => {
      const { body } = await register();
      const wrongPw = await login(body.email, 'Wrong@1234');
      const unknown = await login(`nobody${uniq()}${DOMAIN}`, PASSWORD);
      const unknownMobile = await login('9000000000', PASSWORD);
      for (const r of [wrongPw, unknown, unknownMobile]) {
        expect(r.status).toBe(401);
        expect(r.headers['set-cookie']).toBeUndefined();
      }
      expect(wrongPw.body.error).toEqual(unknown.body.error);
      expect(wrongPw.body.error).toEqual(unknownMobile.body.error);
    });

    it('logout requires CSRF, then invalidates the session server-side', async () => {
      const { body } = await register();
      const l = await login(body.email);
      const cookie = sessionCookie(l);
      const csrf = l.body.data.csrfToken as string;

      expect((await request(app).post('/api/v1/auth/logout').set('Cookie', cookie)).body.error.code).toBe('CSRF_INVALID');
      expect((await request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set('X-CSRF-Token', 'wrong')).status).toBe(403);
      const out = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set('X-CSRF-Token', csrf);
      expect(out.status).toBe(200);
      expect(cookieOf(out)).toMatch(/cp_sid=;/);
      // The old cookie is useless even if an attacker kept a copy.
      expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(401);
    });

    it('expires sessions', async () => {
      const { res } = await register();
      const cookie = sessionCookie(res);
      expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(200);
      await db.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [res.body.data.user.id]);
      expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(401);
    });

    it('rotates the session on login: a presented session is revoked and a new token issued', async () => {
      const { body } = await register();
      const first = await login(body.email);
      const second = await request(app).post('/api/v1/auth/login').set('Cookie', sessionCookie(first)).send({ identifier: body.email, password: PASSWORD });
      expect(sessionCookie(second)).not.toBe(sessionCookie(first));
      expect((await request(app).get('/api/v1/auth/me').set('Cookie', sessionCookie(first))).status).toBe(401);
      expect((await request(app).get('/api/v1/auth/me').set('Cookie', sessionCookie(second))).status).toBe(200);
    });

    it('rejects a forged or missing cookie and disabled accounts', async () => {
      expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
      expect((await request(app).get('/api/v1/auth/me').set('Cookie', 'cp_sid=forged')).status).toBe(401);
      const { res, body } = await register();
      await db.query(`UPDATE users SET status = 'DISABLED' WHERE id = $1`, [res.body.data.user.id]);
      expect((await request(app).get('/api/v1/auth/me').set('Cookie', sessionCookie(res))).status).toBe(401);
      expect((await login(body.email)).status).toBe(401);
    });

    it('locks an identifier after repeated failures, even for the right password', async () => {
      const { body } = await register();
      for (let i = 0; i < 5; i++) expect((await login(body.email, 'Wrong@1234')).status).toBe(401);
      const locked = await login(body.email);
      expect(locked.status).toBe(429);
      expect(locked.body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('authorization', () => {
    const shells: [Role, string][] = [
      ['PATIENT', '/api/v1/patient/dashboard'],
      ['DOCTOR', '/api/v1/doctor/dashboard'],
      ['PHARMACIST', '/api/v1/pharmacy/dashboard'],
      ['ADMIN', '/api/v1/admin/dashboard'],
    ];

    it('returns 401 for every protected API when unauthenticated', async () => {
      for (const [, path] of shells) expect((await request(app).get(path)).status).toBe(401);
    });

    it('serves each dashboard only to its own role (403 otherwise) and returns only the caller\'s profile', async () => {
      const emails: Record<Role, string> = {
        PATIENT: (await register()).body.email,
        DOCTOR: await staff('DOCTOR'),
        PHARMACIST: await staff('PHARMACIST'),
        ADMIN: await staff('ADMIN'),
      };
      for (const [role, email] of Object.entries(emails) as [Role, string][]) {
        const cookie = sessionCookie(await login(email));
        for (const [shellRole, path] of shells) {
          const res = await request(app).get(path).set('Cookie', cookie);
          if (shellRole === role) {
            expect(res.status, `${role} -> ${path}`).toBe(200);
            expect(res.body.data.profile.email).toBe(email);
            expect(JSON.stringify(res.body)).not.toMatch(/password/i);
          } else {
            expect(res.status, `${role} -> ${path}`).toBe(403);
            expect(res.body.error.code).toBe('FORBIDDEN');
          }
        }
      }
    });
  });

  describe('browser security', () => {
    it('refuses state-changing requests from a foreign Origin (login CSRF)', async () => {
      const res = await request(app).post('/api/v1/auth/login').set('Origin', 'https://evil.example').send({ identifier: 'a@b.co', password: 'x' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_ORIGIN');
      const ok = await request(app).post('/api/v1/auth/login').set('Origin', TEST_ORIGIN).send({ identifier: 'nobody@b.co', password: 'x' });
      expect(ok.status).toBe(401);
    });

    it('uses a __Host- Secure SameSite=None cookie in production', async () => {
      const prodApp = buildApp(db, { limits: roomy, env: { APP_ORIGIN: [TEST_ORIGIN], NODE_ENV: 'production', SESSION_TTL_HOURS: 8 } });
      const res = await request(prodApp).post('/api/v1/auth/register').send(payload());
      const cookie = cookieOf(res);
      expect(res.status).toBe(201);
      expect(cookie).toMatch(/^__Host-cp_sid=/);
      expect(cookie).toMatch(/Secure/i);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=None/i);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).not.toMatch(/Domain=/i);
    });

    it('never logs passwords, cookies or session tokens', async () => {
      const lines: string[] = [];
      const logger = createLogger('trace', { write: (s: string) => void lines.push(s) });
      const loud = buildApp(db, { limits: roomy, logger });
      const body = payload({ password: 'Sup3r!SecretValue' });
      const reg = await request(loud).post('/api/v1/auth/register').send(body);
      const token = sessionCookie(reg).split('=')[1]!;
      await request(loud).post('/api/v1/auth/login').send({ identifier: body.email, password: 'Sup3r!SecretValue' });
      await request(loud).get('/api/v1/auth/me').set('Cookie', sessionCookie(reg));
      const out = lines.join('');
      expect(out.length).toBeGreaterThan(0);
      for (const secret of ['Sup3r!SecretValue', token, reg.body.data.csrfToken]) expect(out).not.toContain(secret);
    });
  });
});
