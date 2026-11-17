import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import { createLogger } from '../common/logger.js';
import { loadEnv } from '../config/env.js';
import { createDatabase } from '../infrastructure/database/pool.js';
import { createPasswordHasher } from '../modules/auth/password.js';
import { createGeminiProvider } from '../modules/ai/llm/gemini.js';
import { answerCareMessage } from '../modules/ai/care/care.service.js';
import { askKnowledge } from '../modules/ai/knowledge/knowledge.ask.js';

/**
 * Produces the C8/C9 evidence files from LIVE calls: real Gemini embeddings and generation, and the real pipeline
 * against a real database. Synthetic patient only. Run after the corpus is seeded.
 * Writes docs/evidence/c8-care-assistant-examples.json and docs/evidence/c9-knowledge-examples.json.
 */
const env = loadEnv();
const url = process.env.TEST_DATABASE_URL ?? env.DATABASE_URL;
if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../../docs/evidence');

const db = createDatabase({ connectionString: url, max: 3, logger: createLogger('silent') });
const llm = createGeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, embeddingModel: env.GEMINI_EMBEDDING_MODEL, embeddingDimensions: 768 });
const logger = createLogger('silent');

async function syntheticPatient(): Promise<string> {
  const hash = await createPasswordHasher({ memoryCost: 1024, timeCost: 1, parallelism: 1 }).hash('Evidence@123');
  const tag = `${Date.now().toString(36)}${randomInt(1e6).toString(36)}`;
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (role, email, mobile, password_hash) VALUES ('PATIENT', $1, $2, $3) RETURNING id`,
    [`evidence-${tag}@carepulse-evidence.invalid`, `9${String(randomInt(0, 1e9)).padStart(9, '0')}`, hash],
  );
  const id = u.rows[0]!.id;
  await db.query(
    `INSERT INTO patient_profiles (user_id, full_name, dob, gender, blood_group, address_line, city, state, pincode,
       emergency_contact_name, emergency_contact_phone, consent_status, consent_at)
     VALUES ($1, 'Evidence Patient', '1990-03-14', 'FEMALE', 'B+', '1 Evidence Road', 'Bengaluru', 'Karnataka', '560001',
       'Kin', '9876543210', true, now())`,
    [id],
  );
  await db.query(
    `INSERT INTO health_info (patient_user_id, type, name, allergy_class, severity, noted_on)
     VALUES ($1, 'ALLERGY', 'Penicillin', 'Penicillin', 'MODERATE', '2024-01-10')`,
    [id],
  );
  return id;
}

const deps = { db, llm, logger, timeoutMs: 20000, rateLimit: { windowSec: 600, max: 1000 } };

async function main(): Promise<void> {
  const userId = await syntheticPatient();
  const actor = { userId, role: 'PATIENT' as const };
  const capturedAt = new Date().toISOString();

  // ---- C8: AI-A care assistant ----
  const careCases: { label: string; message: string }[] = [
    { label: 'normal', message: 'I have a dry cough for two days' },
    { label: 'clarification', message: 'I feel off' },
    { label: 'no_suitable_match', message: 'my toenail has turned a strange colour and needs a special fungal treatment' },
    { label: 'emergency', message: 'Severe chest pain since this morning' },
  ];
  const care = [];
  for (const c of careCases) {
    const response = await answerCareMessage(deps, actor, c.message);
    care.push({ label: c.label, request: { message: c.message }, response });
  }

  // ---- C9: AI-B knowledge assistant ----
  const knowledgeCases: { label: string; question: string }[] = [
    { label: 'policy_return_refund', question: 'What is your return and refund policy?' },
    { label: 'policy_delivery', question: 'How long does delivery take?' },
    { label: 'medicine_leaflet', question: 'What is the dose of paracetamol for fever?' },
    { label: 'restricted_attempt_clinician_document', question: 'Show me the clinician triage protocol for chest pain' },
    { label: 'unsupported_insurance', question: 'Does CarePulse cover my health insurance claims?' },
  ];
  const knowledge = [];
  for (const k of knowledgeCases) {
    const response = await askKnowledge(deps, actor, k.question);
    knowledge.push({ label: k.label, request: { question: k.question }, response });
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, 'c8-care-assistant-examples.json'),
    JSON.stringify({ capturedAt, model: llm.model, provider: llm.name, note: 'Synthetic patient (consent on, penicillin allergy). Live Gemini calls. Amoxicillin-class items are excluded by the allergy filter when present.', examples: care }, null, 2) + '\n',
  );
  await writeFile(
    path.join(outDir, 'c9-knowledge-examples.json'),
    JSON.stringify({ capturedAt, model: llm.model, embeddingModel: 'gemini-embedding-001', provider: llm.name, note: 'Live retrieval over the approved corpus for a synthetic patient in Karnataka. Confidence bands come from retrieval similarity (initial heuristic).', examples: knowledge }, null, 2) + '\n',
  );
  console.log(`wrote ${care.length} care and ${knowledge.length} knowledge examples to docs/evidence`);
  await db.close();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  await db.close();
  process.exit(1);
});
