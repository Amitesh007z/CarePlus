import 'dotenv/config';
import { createApp } from './app.js';
import { createLogger } from './common/logger.js';
import { EnvValidationError, loadEnv } from './config/env.js';
import { createDatabase } from './infrastructure/database/pool.js';
import { createSearchProvider, startSearchWorker } from './modules/search/search-runtime.js';
import { createMailer } from './modules/commerce/mailer.js';
import { dispatchNotifications } from './modules/commerce/notifications.js';
import { createGeminiProvider } from './modules/ai/llm/gemini.js';

function main(): void {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    // Fail fast before the logger exists. Message names variables only, never values.
    process.stderr.write(`${err instanceof EnvValidationError ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const logger = createLogger(env.LOG_LEVEL);
  const db = createDatabase({ connectionString: env.DATABASE_URL, max: env.DB_POOL_MAX, logger });
  const search = createSearchProvider(env);
  const mailer = createMailer(env);
  // AI provider: optional. Without GEMINI_API_KEY the assistants answer with their safe fallback only.
  const llm = env.GEMINI_API_KEY
    ? createGeminiProvider({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
        embeddingModel: env.GEMINI_EMBEDDING_MODEL,
        embeddingDimensions: 768,
      })
    : null;
  if (!llm) logger.warn({}, 'GEMINI_API_KEY not set: AI assistants use their safe fallback');
  const app = createApp({
    env,
    db,
    logger,
    search,
    mailer,
    llm,
    aiTimeoutMs: env.AI_LLM_TIMEOUT_MS,
    aiCareRateLimit: { windowSec: env.AI_CARE_RATE_WINDOW_SEC, max: env.AI_CARE_RATE_LIMIT_MAX },
    aiKnowledgeRateLimit: { windowSec: env.AI_CARE_RATE_WINDOW_SEC, max: env.AI_KNOWLEDGE_RATE_LIMIT_MAX },
  });
  // Confirmation emails that failed or were never sent (no SMTP at the time) are retried here.
  const mailTimer = setInterval(() => void dispatchNotifications(db, mailer).catch(() => undefined), 30_000);
  mailTimer.unref();
  const stopWorker = search
    ? startSearchWorker({ db, provider: search, logger })
    : (logger.warn({}, 'search provider not configured: search uses PostgreSQL and indexing is paused'), () => undefined);
  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT, search: search !== null }, 'api listening'));

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    stopWorker();
    clearInterval(mailTimer);
    server.close(() => {
      db.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
