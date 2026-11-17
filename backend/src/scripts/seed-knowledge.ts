import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../common/logger.js';
import { loadEnv } from '../config/env.js';
import { createDatabase } from '../infrastructure/database/pool.js';
import { createGeminiProvider } from '../modules/ai/llm/gemini.js';
import { seedKnowledgeCorpus } from '../modules/ai/knowledge/knowledge.seed.js';

/**
 * Seeds the knowledge corpus from backend/knowledge/*.md. Needs GEMINI_API_KEY for embeddings and an ADMIN account,
 * because the seed's audit rows name an admin as the actor.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '../../knowledge');

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required to embed the knowledge corpus');
  const logger = createLogger(env.LOG_LEVEL);
  const db = createDatabase({ connectionString: env.DIRECT_DATABASE_URL ?? env.DATABASE_URL, max: 2, logger });
  const llm = createGeminiProvider({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    embeddingDimensions: 768,
  });
  try {
    const admin = await db.query<{ id: string }>(`SELECT id FROM users WHERE role = 'ADMIN' ORDER BY created_at LIMIT 1`);
    const adminId = admin.rows[0]?.id;
    if (!adminId) throw new Error('Create an ADMIN account first: the seed records its actions against an admin');
    for (const r of await seedKnowledgeCorpus(db, llm, dir, adminId)) {
      console.log(`${r.file}: ${r.slug} v${r.version} ${r.status}`);
    }
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
