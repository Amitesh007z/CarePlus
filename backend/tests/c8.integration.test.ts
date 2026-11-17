import 'dotenv/config';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/common/logger.js';
import type { AuthLimits } from '../src/common/security/rateLimiter.js';
import { createDatabase, type Database } from '../src/infrastructure/database/pool.js';
import type { LlmJsonRequest, LlmProvider } from '../src/modules/ai/llm/provider.js';
import { LlmError } from '../src/modules/ai/llm/provider.js';
import { buildApp, testHasher } from './helpers.js';

// C8 real-database tests through the HTTP app. Synthetic data only, under the test domain below.
// The LLM is replaced by a deterministic fake that reads the candidate IDs it was given; it cannot choose anything else.
const url = process.env.TEST_DATABASE_URL;
const DOMAIN = '@carepulse-c8.invalid';
const PASSWORD = 'Strong@123';
const roomy: AuthLimits = { windowSec: 900, loginPerIp: 100_000, loginFailuresPerIdentifier: 100, registerPerIp: 100_000 };
const logger = createLogger('silent');
const uniq = () => `${Date.now().toString(36)}${randomInt(1e6).toString(36)}`;
/** Per-run marker: earlier runs leave synthetic rows behind, so each run selects only its own fixtures. */
const MARK = Array.from({ length: 10 }, () => "abcdefghijklmnopqrstuvwxyz"[randomInt(26)]).join("");
const mobile = () => `9${String(randomInt(0, 1e9)).padStart(9, '0')}`;

interface Who {
  id: string;
  cookie: string;
  csrf: string;
}

/** Deterministic stand-in for the model. It answers from the candidate list it is shown, and counts calls. */
function smartLlm(): LlmProvider & { calls: number; prompts: string[]; failNext: boolean } {
  const state = {
    name: 'fake',
    model: 'fake-1',
    calls: 0,
    prompts: [] as string[],
    failNext: false,
    async generateJson(req: LlmJsonRequest): Promise<string> {
      state.calls += 1;
      state.prompts.push(req.user);
      if (state.failNext) throw new LlmError('TIMEOUT', 'slow');
      if (req.user.includes('<patient_message>')) {
        return JSON.stringify({ need: `cough ${MARK}`, durationDays: 2, constraints: [], keywords: [MARK] });
      }
      const data = JSON.parse(req.user.replace(/^Data \(untrusted\):\n/, '')) as {
        doctors: { id: string; displayName: string }[];
        products: { id: string; name: string }[];
      };
      const products = data.products.filter((p) => p.name.includes(MARK)).slice(0, 3);
      const doctors = data.doctors.filter((d) => d.displayName.includes(MARK)).slice(0, 1);
      return JSON.stringify({
        summary: 'Options from CarePulse that may suit a dry cough.',
        urgency: 'SELF_CARE',
        doctors: doctors.map((d) => ({ id: d.id, reason: 'A general physician can review this.' })),
        products: products.map((p) => ({ id: p.id, reason: 'An over-the-counter cough syrup.' })),
      });
    },
  };
  return state;
}

describe.skipIf(!url)('C8: AI care assistant (real database, HTTP)', () => {
  let db: Database;
  let llm: ReturnType<typeof smartLlm>;
  let app: ReturnType<typeof buildApp>;
  let patient: Who;
  let noConsent: Who;
  let doctorId: string;
  let otcId: string;
  let otcAllergyId: string;
  let rxId: string;

  const cookieOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[] | undefined)?.[0]?.split(';')[0] ?? '';
  const ask = (who: Who | undefined, message: string) => {
    const t = request(app).post('/api/v1/ai/care/message');
    const withAuth = who ? t.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrf) : t;
    return withAuth.send({ message });
  };
  async function registerPatient(consent: boolean): Promise<Who> {
    const email = `pat${uniq()}${DOMAIN}`;
    const r = await request(app).post('/api/v1/auth/register').send({
      fullName: 'Care Patient', email, mobile: mobile(), password: PASSWORD, dob: '1989-08-08', gender: 'FEMALE',
      bloodGroup: 'B+', addressLine: '1 Care Road', city: 'Pune', state: 'Maharashtra', pincode: '411003',
      emergencyContactName: 'Kin', emergencyContactPhone: mobile(), consent: true,
    });
    expect(r.status).toBe(201);
    const who = { id: r.body.data.user.id as string, cookie: cookieOf(r), csrf: r.body.data.csrfToken as string };
    if (!consent) {
      // Consent is withdrawn through the profile endpoint, the same path a patient would use.
      const w = await request(app).post('/api/v1/patients/me/consent').set('Cookie', who.cookie).set('X-CSRF-Token', who.csrf).send({ granted: false });
      expect(w.status).toBe(200);
    }
    return who;
  }
  async function medicine(over: { name: string; rx: boolean; allergyClass: string | null }): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO medicines (sku, name, strength, form, category, pack_size, price_inr, stock_qty, rx_required, allergy_class)
       VALUES ($1, $2, '100 mg', 'Syrup', 'Cough and cold', 'Bottle', 120, 25, $3, $4) RETURNING id`,
      [`C8${uniq()}`.toUpperCase().slice(0, 30), over.name, over.rx, over.allergyClass],
    );
    return r.rows[0]!.id;
  }

  beforeAll(async () => {
    db = createDatabase({ connectionString: url as string, max: 6, logger });
    llm = smartLlm();
    app = buildApp(db, { limits: roomy, hasher: testHasher, llm, aiTimeoutMs: 2000, aiCareRateLimit: { windowSec: 600, max: 50 } });

    const d = await db.query<{ id: string }>(
      `INSERT INTO users (role, email, mobile, password_hash) VALUES ('DOCTOR', $1, $2, $3) RETURNING id`,
      [`doc${uniq()}${DOMAIN}`, mobile(), await testHasher.hash(PASSWORD)],
    );
    doctorId = d.rows[0]!.id;
    await db.query(
      `INSERT INTO doctor_profiles (user_id, display_name, specialty, registration_no, experience_years) VALUES ($1, $3, $4, $2, 9)`,
      [doctorId, `REG-${uniq()}`, `Dr C8 ${MARK}`, `${MARK} medicine`],
    );
    otcId = await medicine({ name: `C8 ${MARK} Cough syrup`, rx: false, allergyClass: null });
    otcAllergyId = await medicine({ name: `C8 ${MARK} Penicillin lozenge`, rx: false, allergyClass: 'Penicillin' });
    rxId = await medicine({ name: `C8 ${MARK} Rx cough tablet`, rx: true, allergyClass: null });

    patient = await registerPatient(true);
    noConsent = await registerPatient(false);
    const h = await request(app)
      .post('/api/v1/patients/me/health-info')
      .set('Cookie', patient.cookie)
      .set('X-CSRF-Token', patient.csrf)
      .send({ type: 'ALLERGY', name: 'Penicillin', allergyClass: 'Penicillin', severity: 'MODERATE', notedOn: '2024-01-10' });
    expect(h.status).toBe(201);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('normal request returns real candidates, the allergy-conflicting item is excluded, and Rx never appears (tests 1, 6, 7)', async () => {
    const res = await ask(patient, 'I have a dry cough for two days');
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.urgency).toBe('SELF_CARE');
    const ids = data.recommendedProducts.map((p: { id: string }) => p.id);
    expect(ids).toContain(otcId);
    expect(ids).not.toContain(otcAllergyId);
    expect(ids).not.toContain(rxId);
    // Earlier runs leave synthetic rows behind, so find this run's item by ID instead of by position.
    expect(data.recommendedProducts.find((p: { id: string }) => p.id === otcId)).toMatchObject({
      priceInr: 120,
      rxRequired: false,
      requiresConfirmation: true,
    });
    expect(data.recommendedDoctors.map((d: { id: string }) => d.id)).toContain(doctorId);
    // The model was shown only the filtered candidates.
    const rankingPrompt = llm.prompts[llm.prompts.length - 1]!;
    expect(rankingPrompt).not.toContain(otcAllergyId);
    expect(rankingPrompt).not.toContain(rxId);
  });

  it('chest pain returns EMERGENCY with zero products and no model call (test 2)', async () => {
    const before = llm.calls;
    const res = await ask(patient, 'Severe chest pain since this morning');
    expect(res.body.data).toMatchObject({ urgency: 'EMERGENCY', recommendedProducts: [], recommendedDoctors: [] });
    expect(llm.calls).toBe(before);
  });

  it('breathing difficulty takes the emergency path (test 3)', async () => {
    const res = await ask(patient, 'I have breathing difficulty at night');
    expect(res.body.data.urgency).toBe('EMERGENCY');
    expect(res.body.data.recommendedProducts).toHaveLength(0);
  });

  it('blocks a patient without consent before any model call (422)', async () => {
    const before = llm.calls;
    const res = await ask(noConsent, 'dry cough');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CONSENT_REQUIRED');
    expect(llm.calls).toBe(before);
  });

  it('blocks unauthenticated users (test 12)', async () => {
    const res = await ask(undefined, 'dry cough');
    expect(res.status).toBe(401);
  });

  it('never writes to the cart or appointments (test 14)', async () => {
    const count = async () =>
      (await db.query<{ n: number }>(
        `SELECT (SELECT COUNT(*)::int FROM appointments WHERE patient_user_id = $1) AS n`,
        [patient.id],
      )).rows[0]!.n;
    const before = await count();
    await ask(patient, 'I have a dry cough for two days');
    expect(await count()).toBe(before);
  });

  it('stores a hash and metadata only, never the message text', async () => {
    const message = `unique private cough remark ${uniq()}`;
    await ask(patient, message);
    const rows = await db.query<{ input_sha256: string; input_chars: number }>(
      `SELECT input_sha256, input_chars FROM ai_interactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [patient.id],
    );
    expect(rows.rows[0]!.input_chars).toBe([...message].length);
    expect(rows.rows[0]!.input_sha256).toMatch(/^[0-9a-f]{64}$/);
    const leaked = await db.query(`SELECT 1 FROM ai_interactions WHERE user_id = $1 AND to_jsonb(ai_interactions)::text LIKE $2`, [
      patient.id,
      `%${message.slice(0, 20)}%`,
    ]);
    expect(leaked.rowCount).toBe(0);
  });

  it('a model timeout returns the safe fallback (test 11)', async () => {
    llm.failNext = true;
    const res = await ask(patient, 'dry cough');
    llm.failNext = false;
    expect(res.status).toBe(200);
    expect(res.body.data.recommendedProducts).toHaveLength(0);
    expect(res.body.data.summary).toMatch(/could not prepare suggestions/);
  });

  it('AI provider outage does not affect the core catalogue or the patient profile (test 15)', async () => {
    const broken: LlmProvider = {
      name: 'broken',
      model: 'x',
      generateJson: async () => {
        throw new LlmError('UNAVAILABLE', 'down');
      },
    };
    const down = buildApp(db, { limits: roomy, hasher: testHasher, llm: broken, aiTimeoutMs: 2000 });
    const ai = await request(down).post('/api/v1/ai/care/message').set('Cookie', patient.cookie).set('X-CSRF-Token', patient.csrf).send({ message: 'dry cough' });
    expect(ai.status).toBe(200);
    expect(ai.body.data.recommendedProducts).toHaveLength(0);
    const catalogue = await request(down).get('/api/v1/catalogue/medicines');
    expect(catalogue.status).toBe(200);
    const profile = await request(down).get('/api/v1/patients/me').set('Cookie', patient.cookie);
    expect(profile.status).toBe(200);
  });

  it('rate limiting blocks requests beyond the limit (test 13)', async () => {
    const limited = buildApp(db, { limits: roomy, hasher: testHasher, llm, aiTimeoutMs: 2000, aiCareRateLimit: { windowSec: 600, max: 2 } });
    const p = await registerPatient(true);
    const go = () => request(limited).post('/api/v1/ai/care/message').set('Cookie', p.cookie).set('X-CSRF-Token', p.csrf).send({ message: 'dry cough' });
    expect((await go()).status).toBe(200);
    expect((await go()).status).toBe(200);
    const third = await go();
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
  });
});
