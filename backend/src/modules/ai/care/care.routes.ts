import { Router } from 'express';
import type { Logger } from 'pino';
import { send, auditContext } from '../../../common/http.js';
import type { Database } from '../../../infrastructure/database/pool.js';
import { protect } from '../../auth/auth.middleware.js';
import type { LlmProvider } from '../llm/provider.js';
import { answerCareMessage } from './care.service.js';
import { careRequestSchema } from './care.schemas.js';

export interface CareRouterDeps {
  db: Database;
  nodeEnv: string;
  llm: LlmProvider | null;
  logger: Logger;
  timeoutMs: number;
  rateLimit: { windowSec: number; max: number };
}

/** AI-A. Patients only. The assistant reads patient context and never writes to the cart or appointments. */
export function careRouter(deps: CareRouterDeps): Router {
  const r = Router();
  r.post('/ai/care/message', ...protect({ db: deps.db, nodeEnv: deps.nodeEnv }, 'PATIENT'), async (req, res) => {
    const { message } = careRequestSchema.parse(req.body);
    const response = await answerCareMessage(
      { db: deps.db, llm: deps.llm, logger: deps.logger, timeoutMs: deps.timeoutMs, rateLimit: deps.rateLimit },
      { userId: req.auth!.userId, role: req.auth!.role },
      message,
      auditContext(req).requestId,
    );
    send(req, res, response);
  });
  return r;
}
