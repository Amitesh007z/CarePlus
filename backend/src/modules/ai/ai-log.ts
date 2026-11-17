import { createHash } from 'node:crypto';
import type { Queryable } from '../../infrastructure/database/pool.js';

export type AiFeature = 'CARE' | 'KNOWLEDGE';
export type AiOutcome =
  | 'EMERGENCY'
  | 'CLARIFICATION'
  | 'ANSWERED'
  | 'NO_MATCH'
  | 'NOT_COVERED'
  | 'FALLBACK'
  | 'BLOCKED'
  | 'RATE_LIMITED';

export interface AiLogEntry {
  feature: AiFeature;
  userId: string | null;
  role: 'PATIENT' | 'DOCTOR' | 'PHARMACIST' | 'ADMIN';
  /** The raw input is hashed here and never stored. */
  input: string;
  outcome: AiOutcome;
  urgency?: 'SELF_CARE' | 'SEE_DOCTOR' | 'EMERGENCY' | null;
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  redFlagLabels?: string[];
  candidateCount?: number;
  recommendedCount?: number;
  topScore?: number | null;
  provider?: string | null;
  model?: string | null;
  llmAttempts?: number;
  latencyMs?: number;
  errorCode?: string | null;
  requestId?: string;
}

export const hashInput = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

/**
 * Append-only AI interaction log. Stores identifiers, counts and outcomes. Never the message text,
 * never the model output, never health details.
 */
export async function logAiInteraction(db: Queryable, e: AiLogEntry): Promise<void> {
  await db.query(
    `INSERT INTO ai_interactions (feature, user_id, role, input_sha256, input_chars, outcome, urgency, confidence,
       red_flag_labels, candidate_count, recommended_count, top_score, provider, model, llm_attempts, latency_ms,
       error_code, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      e.feature,
      e.userId,
      e.role,
      hashInput(e.input),
      [...e.input].length,
      e.outcome,
      e.urgency ?? null,
      e.confidence ?? null,
      e.redFlagLabels ?? [],
      e.candidateCount ?? 0,
      e.recommendedCount ?? 0,
      e.topScore ?? null,
      e.provider ?? null,
      e.model ?? null,
      e.llmAttempts ?? 0,
      e.latencyMs ?? null,
      e.errorCode ?? null,
      e.requestId ?? null,
    ],
  );
}
