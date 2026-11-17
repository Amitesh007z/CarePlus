import { Router } from 'express';
import { z } from 'zod';
import type { Logger } from 'pino';
import { auditContext, parseUuid, send } from '../../../common/http.js';
import type { Database } from '../../../infrastructure/database/pool.js';
import { protect } from '../../auth/auth.middleware.js';
import type { LlmProvider } from '../llm/provider.js';
import { askKnowledge, questionSchema } from './knowledge.ask.js';
import {
  archiveVersion,
  approveVersion,
  createDraftVersion,
  getDocument,
  listDocuments,
  reindexDocument,
} from './knowledge.service.js';

export interface KnowledgeRouterDeps {
  db: Database;
  nodeEnv: string;
  llm: LlmProvider | null;
  logger: Logger;
  timeoutMs: number;
  rateLimit: { windowSec: number; max: number };
}

const uploadSchema = z.strictObject({
  /** The full Markdown document, including its `---` front matter. */
  markdown: z.string().min(20).max(90_000),
});

/** AI-B (ask) for any signed-in role, and the admin knowledge console. Access is enforced per route and in the policy. */
export function knowledgeRouter(deps: KnowledgeRouterDeps): Router {
  const r = Router();
  const base = { db: deps.db, nodeEnv: deps.nodeEnv };

  r.post('/knowledge/ask', ...protect(base), async (req, res) => {
    const { question } = questionSchema.parse(req.body);
    const answer = await askKnowledge(
      { db: deps.db, llm: deps.llm, logger: deps.logger, timeoutMs: deps.timeoutMs, rateLimit: deps.rateLimit },
      { userId: req.auth!.userId, role: req.auth!.role },
      question,
      auditContext(req).requestId,
    );
    send(req, res, answer);
  });

  const admin = protect(base, 'ADMIN');

  r.get('/admin/knowledge/documents', ...admin, async (req, res) => {
    send(req, res, { items: await listDocuments(deps.db) });
  });

  r.get('/admin/knowledge/documents/:id', ...admin, async (req, res) => {
    send(req, res, await getDocument(deps.db, parseUuid(req.params.id)));
  });

  r.post('/admin/knowledge/documents', ...admin, async (req, res) => {
    const { markdown } = uploadSchema.parse(req.body);
    const doc = await createDraftVersion(deps.db, markdown, { ...auditContext(req), userId: req.auth!.userId }, deps.llm);
    send(req, res, doc, 201);
  });

  r.post('/admin/knowledge/documents/:id/reindex', ...admin, async (req, res) => {
    send(req, res, await reindexDocument(deps.db, parseUuid(req.params.id), deps.llm, auditContext(req)));
  });

  r.post('/admin/knowledge/documents/:id/approve', ...admin, async (req, res) => {
    send(req, res, await approveVersion(deps.db, parseUuid(req.params.id), auditContext(req)));
  });

  r.post('/admin/knowledge/documents/:id/archive', ...admin, async (req, res) => {
    send(req, res, await archiveVersion(deps.db, parseUuid(req.params.id), auditContext(req)));
  });

  return r;
}
