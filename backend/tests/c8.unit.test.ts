import { randomUUID, createHash } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/common/logger.js';
import type { Database } from '../src/infrastructure/database/pool.js';
import { answerCareMessage, type CareServiceDeps } from '../src/modules/ai/care/care.service.js';
import { detectRedFlags, forbiddenClaimIn, urgencyFloor, maxUrgency } from '../src/modules/ai/care/care.rules.js';
import { removeAllergyConflicts, type ProductCandidate } from '../src/modules/ai/care/care.repository.js';
import { callStructured, LlmError, type LlmJsonRequest, type LlmProvider } from '../src/modules/ai/llm/provider.js';
import { createGeminiProvider } from '../src/modules/ai/llm/gemini.js';
import { extractionSchema, rankingSchema } from '../src/modules/ai/care/care.schemas.js';
import { buildApp, fakeDb } from './helpers.js';

// C8 unit tests: no network and no database. The LLM is scripted, the database is a SQL-aware fake.

const logger = createLogger('silent');
const PATIENT = randomUUID();
const DOCTOR_ID = randomUUID();
const OTC_ID = randomUUID();
const OTC_ALLERGY_ID = randomUUID();
const RX_ID = randomUUID();

const doctorRow = { id: DOCTOR_ID, display_name: 'Dr Asha Rao', specialty: 'General Physician', experience_years: 9 };
const otcRow = {
  id: OTC_ID, sku: 'MED-1005', name: 'Dextromethorphan syrup', strength: null, form: 'Syrup', category: 'Cough and cold',
  price_inr: '92.00', stock_qty: 40, rx_required: false, allergy_class: null,
};
const allergyOtcRow = {
  id: OTC_ALLERGY_ID, sku: 'T-PEN', name: 'Penicillin-class lozenge', strength: null, form: 'Lozenge', category: 'Cough and cold',
  price_inr: '50.00', stock_qty: 9, rx_required: false, allergy_class: 'Penicillin',
};
const rxRow = {
  id: RX_ID, sku: 'MED-1002', name: 'Amoxicillin 500 mg capsule', strength: '500 mg', form: 'Capsule', category: 'Antibiotic',
  price_inr: '96.00', stock_qty: 30, rx_required: true, allergy_class: 'Penicillin',
};

interface Scenario {
  profile?: { consent_status: boolean; dob: string | null } | null;
  allergies?: { name: string; allergy_class: string | null }[];
  doctors?: typeof doctorRow[];
  products?: Record<string, unknown>[];
  hits?: number;
}

/** Fake database that answers by SQL fragment and records every statement it receives. */
function scenarioDb(s: Scenario) {
  const statements: { text: string; params: unknown[] }[] = [];
  const handler = (text: string): unknown[] => {
    if (text.includes('FROM patient_profiles')) return s.profile === null ? [] : [s.profile ?? { consent_status: true, dob: '1990-03-14' }];
    if (text.includes('FROM health_info')) return s.allergies ?? [];
    if (text.includes('FROM doctor_profiles')) return s.doctors ?? [doctorRow];
    if (text.includes('FROM medicines')) return s.products ?? [otcRow];
    if (text.includes('rate_limits')) return [{ hits: s.hits ?? 1 }];
    return [];
  };
  const db: Database = {
    query: (async (text: string, params: unknown[] = []) => {
      statements.push({ text, params });
      const rows = handler(text);
      return { rows, rowCount: rows.length };
    }) as unknown as Database['query'],
    transaction: (fn) => fn(db),
    close: async () => undefined,
  };
  return { db, statements };
}

/** Scripted provider. Each call pops the next reply: a string is returned, an Error is thrown. */
function scriptedLlm(script: (string | Error)[]): LlmProvider & { calls: LlmJsonRequest[] } {
  const calls: LlmJsonRequest[] = [];
  return {
    name: 'fake',
    model: 'fake-1',
    calls,
    async generateJson(req) {
      calls.push(req);
      const next = script.shift();
      if (next === undefined) throw new LlmError('UNAVAILABLE', 'script exhausted');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const EXTRACT_OK = JSON.stringify({ need: 'dry cough', durationDays: 2, constraints: [], keywords: ['cough'] });
const EXTRACT_NO_NEED = JSON.stringify({ need: null, durationDays: null, constraints: [], keywords: [] });
const rankOk = (productIds: string[] = [OTC_ID], doctorIds: string[] = [DOCTOR_ID]) =>
  JSON.stringify({
    summary: 'A cough syrup from the catalogue and a general physician may help you decide next steps.',
    urgency: 'SELF_CARE',
    doctors: doctorIds.map((id) => ({ id, reason: 'General physician for initial advice.' })),
    products: productIds.map((id) => ({ id, reason: 'Common over-the-counter cough syrup.' })),
  });

const deps = (db: Database, llm: LlmProvider | null, timeoutMs = 5000): CareServiceDeps => ({
  db,
  llm,
  logger,
  timeoutMs,
  rateLimit: { windowSec: 600, max: 10 },
});
const actor = { userId: PATIENT, role: 'PATIENT' as const };

describe('C8 deterministic rules', () => {
  it('flags the three example red-flag families and nothing else', () => {
    expect(detectRedFlags('I have severe chest pain since morning')).toContain('chest pain');
    expect(detectRedFlags("I can't breathe properly")).toContain('breathing difficulty');
    expect(detectRedFlags('my face drooping on one side')).toContain('possible stroke signs');
    expect(detectRedFlags('I have a mild dry cough')).toEqual([]);
  });

  it('raises urgency for long duration and life-stage constraints, never lowers it', () => {
    expect(urgencyFloor({ durationDays: 2, lifeStageConstraint: false })).toBe('SELF_CARE');
    expect(urgencyFloor({ durationDays: 7, lifeStageConstraint: false })).toBe('SEE_DOCTOR');
    expect(urgencyFloor({ durationDays: null, lifeStageConstraint: true })).toBe('SEE_DOCTOR');
    expect(maxUrgency('SEE_DOCTOR', 'SELF_CARE')).toBe('SEE_DOCTOR');
  });

  it('rejects model text that makes clinical, price or stock claims', () => {
    expect(forbiddenClaimIn(['This will cure the cough.'])).not.toBeNull();
    expect(forbiddenClaimIn(['It costs ₹92 today.'])).not.toBeNull();
    expect(forbiddenClaimIn(['Currently in stock.'])).not.toBeNull();
    expect(forbiddenClaimIn(['You have bronchitis.'])).not.toBeNull();
    expect(forbiddenClaimIn(['A general physician can advise you.'])).toBeNull();
    expect(forbiddenClaimIn(['General physician available for consultation.'])).toBeNull();
    expect(forbiddenClaimIn(['Let us rule out underlying issues.'])).not.toBeNull();
  });
});

describe('C8 provider-neutral structured calls', () => {
  const opts = { system: 's', user: 'u', timeoutMs: 1000, schema: extractionSchema };

  it('retries invalid JSON exactly once and then succeeds (test 9)', async () => {
    const llm = scriptedLlm(['not json at all', EXTRACT_OK]);
    const r = await callStructured(llm, opts);
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(llm.calls).toHaveLength(2);
  });

  it('returns INVALID after the second invalid reply (test 10)', async () => {
    const llm = scriptedLlm(['{"need": 5}', 'still bad']);
    const r = await callStructured(llm, opts);
    expect(r).toEqual({ ok: false, reason: 'INVALID', attempts: 2 });
    expect(llm.calls).toHaveLength(2);
  });

  it('does not retry a timeout and reports TIMEOUT (test 11)', async () => {
    const llm = scriptedLlm([new LlmError('TIMEOUT', 'slow')]);
    const r = await callStructured(llm, opts);
    expect(r).toEqual({ ok: false, reason: 'TIMEOUT', attempts: 1 });
    expect(llm.calls).toHaveLength(1);
  });

  it('rejects extra keys (strict schema)', async () => {
    const llm = scriptedLlm([JSON.stringify({ need: 'x', durationDays: 1, constraints: [], keywords: [], price: 5 }), EXTRACT_OK]);
    expect(await callStructured(llm, opts)).toMatchObject({ ok: true, attempts: 2 });
  });

  it('keeps provider errors free of keys: the Gemini adapter reports status codes only', async () => {
    const secret = 'AQ.test-secret-value-123';
    const fetchImpl = (async () => new Response('{"error":"bad key ' + secret + '"}', { status: 403 })) as unknown as typeof fetch;
    const p = createGeminiProvider({ apiKey: secret, model: 'm', embeddingModel: 'e', embeddingDimensions: 768, fetchImpl });
    const err = await p.generateJson({ system: 's', user: 'u', timeoutMs: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(String((err as Error).message)).not.toContain(secret);
    expect((err as LlmError).kind).toBe('UNAVAILABLE');
  });

  it('maps an aborted fetch to TIMEOUT', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    const p = createGeminiProvider({ apiKey: 'AQ.abcdefgh', model: 'm', embeddingModel: 'e', embeddingDimensions: 768, fetchImpl });
    await expect(p.generateJson({ system: 's', user: 'u', timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });
});

describe('C8 care pipeline', () => {
  it('normal request returns real database candidates with database prices and IDs (test 1)', async () => {
    const s = scenarioDb({});
    const llm = scriptedLlm([EXTRACT_OK, rankOk()]);
    const r = await answerCareMessage(deps(s.db, llm), actor, 'I have a dry cough for two days');
    expect(r.urgency).toBe('SELF_CARE');
    expect(r.clarificationRequired).toBe(false);
    expect(r.recommendedProducts).toEqual([
      expect.objectContaining({ id: OTC_ID, sku: 'MED-1005', name: 'Dextromethorphan syrup', priceInr: 92, availability: 'IN_STOCK', rxRequired: false, requiresConfirmation: true }),
    ]);
    expect(r.recommendedDoctors).toEqual([expect.objectContaining({ id: DOCTOR_ID, displayName: 'Dr Asha Rao', specialty: 'General Physician' })]);
    expect(r.disclaimer).toMatch(/does not diagnose/);
  });

  it('chest pain returns EMERGENCY with zero products and makes no model call (test 2)', async () => {
    const s = scenarioDb({});
    const llm = scriptedLlm([]);
    const r = await answerCareMessage(deps(s.db, llm), actor, 'Severe chest pain since an hour');
    expect(r.urgency).toBe('EMERGENCY');
    expect(r.recommendedProducts).toHaveLength(0);
    expect(r.recommendedDoctors).toHaveLength(0);
    expect(r.safetyMessage).toMatch(/emergency/i);
    expect(llm.calls).toHaveLength(0);
  });

  it('breathing difficulty takes the emergency path (test 3)', async () => {
    const s = scenarioDb({});
    const llm = scriptedLlm([]);
    const r = await answerCareMessage(deps(s.db, llm), actor, 'I have breathing difficulty and cough');
    expect(r.urgency).toBe('EMERGENCY');
    expect(r.recommendedProducts).toHaveLength(0);
    expect(llm.calls).toHaveLength(0);
  });

  it('emergency still answers when the patient has no consent (guidance is never gated)', async () => {
    const s = scenarioDb({ profile: { consent_status: false, dob: '1990-03-14' } });
    const r = await answerCareMessage(deps(s.db, scriptedLlm([])), actor, 'chest pain');
    expect(r.urgency).toBe('EMERGENCY');
  });

  it('missing need asks a clarification with zero recommendations (tests 4 and 5)', async () => {
    const s = scenarioDb({});
    const llm = scriptedLlm([EXTRACT_NO_NEED]);
    const r = await answerCareMessage(deps(s.db, llm), actor, 'I feel off');
    expect(r.clarificationRequired).toBe(true);
    expect(r.clarificationQuestion).toMatch(/What do you need help with/);
    expect(r.recommendedProducts).toHaveLength(0);
    expect(r.recommendedDoctors).toHaveLength(0);
    expect(r.followUpRequired).toBe(true);
    expect(llm.calls).toHaveLength(1);
  });

  it('a paraphrased need with no searchable keywords still asks a clarification ("I feel off")', async () => {
    const s = scenarioDb({});
    const vague = JSON.stringify({ need: 'feeling unwell', durationDays: null, constraints: [], keywords: [] });
    const llm = scriptedLlm([vague]);
    const r = await answerCareMessage(deps(s.db, llm), actor, 'I feel off');
    expect(r.clarificationRequired).toBe(true);
    expect(r.recommendedProducts).toHaveLength(0);
    expect(r.recommendedDoctors).toHaveLength(0);
    expect(llm.calls).toHaveLength(1);
  });

  it('missing age on the profile asks for it before any suggestion (test 4)', async () => {
    const s = scenarioDb({ profile: { consent_status: true, dob: null } });
    const r = await answerCareMessage(deps(s.db, scriptedLlm([EXTRACT_OK])), actor, 'dry cough');
    expect(r.clarificationRequired).toBe(true);
    expect(r.clarificationQuestion).toMatch(/date of birth/);
    expect(r.recommendedProducts).toHaveLength(0);
  });

  it('penicillin allergy removes a penicillin-class item before the model sees it (test 6)', async () => {
    const s = scenarioDb({
      allergies: [{ name: 'Penicillin', allergy_class: 'Penicillin' }],
      products: [allergyOtcRow, otcRow],
    });
    const llm = scriptedLlm([EXTRACT_OK, rankOk([OTC_ID])]);
    const r = await answerCareMessage(deps(s.db, llm), actor, 'dry cough');
    const rankingPrompt = llm.calls[1]!.user;
    expect(rankingPrompt).not.toContain(OTC_ALLERGY_ID);
    expect(r.recommendedProducts.map((p) => p.id)).toEqual([OTC_ID]);
  });

  it('removeAllergyConflicts drops exact class matches and Rx-only items (tests 6 and 7)', () => {
    const products: ProductCandidate[] = [
      { id: OTC_ID, sku: 'A', name: 'OTC', strength: null, form: 'Tablet', category: 'c', priceInr: 1, stockQty: 3, rxRequired: false, allergyClass: null, availability: 'LOW_STOCK' },
      { id: OTC_ALLERGY_ID, sku: 'B', name: 'PenOTC', strength: null, form: 'Tablet', category: 'c', priceInr: 1, stockQty: 3, rxRequired: false, allergyClass: 'penicillin', availability: 'LOW_STOCK' },
      { id: RX_ID, sku: 'C', name: 'Rx', strength: null, form: 'Tablet', category: 'c', priceInr: 1, stockQty: 3, rxRequired: true, allergyClass: null, availability: 'LOW_STOCK' },
    ];
    const { kept, removedSkus } = removeAllergyConflicts(products, [{ name: 'Penicillin', allergyClass: null }]);
    expect(kept.map((p) => p.id)).toEqual([OTC_ID]);
    expect(removedSkus).toEqual(['B']);
  });

  it('Rx-only products never reach the candidate list even if the database returns them (test 7)', async () => {
    const s = scenarioDb({ products: [rxRow, otcRow] });
    const llm = scriptedLlm([EXTRACT_OK, rankOk([OTC_ID])]);
    await answerCareMessage(deps(s.db, llm), actor, 'dry cough');
    expect(llm.calls[1]!.user).not.toContain(RX_ID);
    const productQuery = s.statements.find((q) => q.text.includes('FROM medicines'))!;
    expect(productQuery.text).toContain('NOT rx_required');
  });

  it('empty candidate set returns no fabricated matches and no ranking call (test 8)', async () => {
    const s = scenarioDb({ products: [], doctors: [] });
    const llm = scriptedLlm([EXTRACT_OK]);
    const r = await answerCareMessage(deps(s.db, llm), actor, 'dry cough');
    expect(r.recommendedProducts).toHaveLength(0);
    expect(r.recommendedDoctors).toHaveLength(0);
    expect(r.summary).toMatch(/No suitable/);
    expect(llm.calls).toHaveLength(1);
  });

  it('a model ID outside the candidate set is rejected, then the retry is used (no invented IDs)', async () => {
    const s = scenarioDb({});
    const llm = scriptedLlm([EXTRACT_OK, rankOk([randomUUID()]), rankOk([OTC_ID])]);
    const r = await answerCareMessage(deps(s.db, llm), actor, 'dry cough');
    expect(r.recommendedProducts.map((p) => p.id)).toEqual([OTC_ID]);
    expect(llm.calls).toHaveLength(3);
  });

  it('a second invalid ranking falls back safely with zero products (test 10)', async () => {
    const s = scenarioDb({});
    const llm = scriptedLlm([EXTRACT_OK, rankOk([randomUUID()]), rankOk([randomUUID()])]);
    const r = await answerCareMessage(deps(s.db, llm), actor, 'dry cough');
    expect(r.recommendedProducts).toHaveLength(0);
    expect(r.recommendedDoctors).toHaveLength(0);
    expect(r.urgency).toBe('SEE_DOCTOR');
    expect(r.followUpRequired).toBe(true);
  });

  it('model timeout returns the safe fallback without a retry (test 11)', async () => {
    const s = scenarioDb({});
    const llm = scriptedLlm([EXTRACT_OK, new LlmError('TIMEOUT', 'slow')]);
    const r = await answerCareMessage(deps(s.db, llm), actor, 'dry cough');
    expect(r.recommendedProducts).toHaveLength(0);
    expect(r.summary).toMatch(/could not prepare suggestions/);
    expect(llm.calls).toHaveLength(2);
  });

  it('no provider configured returns the fallback (AI-A outage)', async () => {
    const s = scenarioDb({});
    const r = await answerCareMessage(deps(s.db, null), actor, 'dry cough');
    expect(r.recommendedProducts).toHaveLength(0);
    expect(r.urgency).toBe('SEE_DOCTOR');
  });

  it('a patient without health-data consent is blocked before any model call (422)', async () => {
    const s = scenarioDb({ profile: { consent_status: false, dob: '1990-03-14' } });
    const llm = scriptedLlm([]);
    await expect(answerCareMessage(deps(s.db, llm), actor, 'dry cough')).rejects.toMatchObject({ status: 422, code: 'CONSENT_REQUIRED' });
    expect(llm.calls).toHaveLength(0);
  });

  it('the rate limit blocks the request before any model call (test 13)', async () => {
    const s = scenarioDb({ hits: 11 });
    const llm = scriptedLlm([]);
    await expect(answerCareMessage(deps(s.db, llm), actor, 'dry cough')).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(llm.calls).toHaveLength(0);
  });

  it('never writes to the cart, orders or appointments, with or without confirmation (test 14)', async () => {
    const s = scenarioDb({});
    await answerCareMessage(deps(s.db, scriptedLlm([EXTRACT_OK, rankOk()])), actor, 'dry cough');
    const writes = s.statements.filter((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q.text));
    const touching = writes.filter((q) => /cart|order|appointment|fulfil|prescription/i.test(q.text));
    expect(touching).toEqual([]);
    // The only writes allowed are the rate-limit counter and the AI interaction log.
    for (const w of writes) expect(w.text).toMatch(/rate_limits|ai_interactions/);
  });

  it('logs a hash and metadata only, never the message text', async () => {
    const message = 'My private dry cough detail 4242';
    const s = scenarioDb({});
    await answerCareMessage(deps(s.db, scriptedLlm([EXTRACT_OK, rankOk()])), actor, message);
    const log = s.statements.find((q) => q.text.includes('INSERT INTO ai_interactions'))!;
    expect(log.params).toContain(createHash('sha256').update(message, 'utf8').digest('hex'));
    expect(log.params.some((p) => typeof p === 'string' && p.includes('private'))).toBe(false);
  });

  it('the schemas reject unknown keys in model output', () => {
    expect(rankingSchema.safeParse({ summary: 'x', urgency: 'SELF_CARE', doctors: [], products: [], price: 1 }).success).toBe(false);
  });
});

describe('C8 HTTP surface', () => {
  it('unauthenticated users are blocked (test 12)', async () => {
    const app = buildApp(fakeDb(() => []));
    const res = await request(app).post('/api/v1/ai/care/message').send({ message: 'dry cough' });
    expect(res.status).toBe(401);
    expect(res.body.error?.code ?? res.body.code).toBe('UNAUTHENTICATED');
  });

  it('an AI provider outage does not affect core public routes (test 15)', async () => {
    const broken: LlmProvider = {
      name: 'broken',
      model: 'x',
      generateJson: async () => {
        throw new LlmError('UNAVAILABLE', 'down');
      },
    };
    const app = buildApp(fakeDb(() => []), { llm: broken, aiTimeoutMs: 1000 });
    const ai = await request(app).post('/api/v1/ai/care/message').send({ message: 'dry cough' });
    // Without a session the AI route refuses; the core catalogue is still served.
    expect(ai.status).toBe(401);
    const core = await request(app).get('/api/v1/catalogue/medicines');
    expect(core.status).toBe(200);
  });
});
