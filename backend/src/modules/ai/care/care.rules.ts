/**
 * Deterministic rules for the AI care assistant. Everything here runs in code, before or after the
 * model, and the model can never weaken a result.
 *
 * LIMITATIONS (document-level, not a clinical protocol):
 * - Red flags are the three example patterns named in the brief (chest pain, breathing difficulty,
 *   possible stroke signs), reused from the appointments module. Matching is keyword-based, so it
 *   misses paraphrases and typos. A missed emergency is possible: the guidance on every screen says so.
 * - Constraint and duration floors are coarse heuristics, not medical judgement.
 * - Allergy matching is exact class/name equality (see prescriptions/matchAllergies). Cross-reactivity is not inferred.
 */
import { redFlagReasons, EMERGENCY_GUIDANCE } from '../../appointments/redFlags.js';

export { EMERGENCY_GUIDANCE };

export const DISCLAIMER =
  'CarePulse\'s care assistant does not diagnose or treat conditions. It only suggests doctors and over-the-counter items from CarePulse\'s catalogue. Nothing is booked or added to your cart until you confirm it. It does not replace advice from a doctor.';

/** Durations at or above this many days raise the result to SEE_DOCTOR. Initial heuristic. */
export const SEE_DOCTOR_DURATION_DAYS = 7;

/** Life-stage words that make OTC self-care unsuitable here. The rule is coarse by design. */
const CONSTRAINT_PATTERN = /\b(pregnan\w*|breast\s?feed\w*|infant|baby|newborn|toddler|child|children|elderly)\b/i;

/**
 * Model text that makes a clinical claim, or states price, stock or availability. Such output is rejected.
 * Plain wording such as "available for consultation" is allowed: only stock, price and availability claims are blocked.
 */
const FORBIDDEN_CLAIM_PATTERN =
  /\bdiagnos\w*|\bcure[sd]?\b|\bguarantee\w*|\byou (have|may have|likely have|probably have)\b|\brule[sd]? out\b|\bprescri(be|bed|bing)\b|₹|\bINR\b|\bRs\.?\s?\d|\b(in|out of) stock\b|\bavailability\b|\bavailable (now|today|right now)\b/i;

export const detectRedFlags = (text: string): string[] => redFlagReasons(text);

export const hasLifeStageConstraint = (text: string): boolean => CONSTRAINT_PATTERN.test(text);

export type Urgency = 'SELF_CARE' | 'SEE_DOCTOR' | 'EMERGENCY';

const RANK: Record<Urgency, number> = { SELF_CARE: 0, SEE_DOCTOR: 1, EMERGENCY: 2 };

/** The more cautious of two urgencies. The model's answer can only raise the floor, never lower it. */
export function maxUrgency(a: Urgency, b: Urgency): Urgency {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Deterministic floor from facts the code can see: duration and life-stage constraints. */
export function urgencyFloor(input: { durationDays: number | null; lifeStageConstraint: boolean }): Urgency {
  if (input.lifeStageConstraint) return 'SEE_DOCTOR';
  if (input.durationDays !== null && input.durationDays >= SEE_DOCTOR_DURATION_DAYS) return 'SEE_DOCTOR';
  return 'SELF_CARE';
}

/** Returns an error message when model text makes a forbidden claim, else null. */
export function forbiddenClaimIn(texts: string[]): string | null {
  for (const t of texts) if (FORBIDDEN_CLAIM_PATTERN.test(t)) return 'forbidden claim in model text';
  return null;
}

export function isRxBlocked(rxRequired: boolean): boolean {
  return rxRequired === true;
}
