/**
 * Access and relevance policy for AI-B, as pure functions. Every filter here is applied in SQL before
 * vector ranking. The model never sees these values and cannot change them.
 */
import type { Role } from '../../auth/session.service.js';

export const DOCUMENT_TYPES = ['POLICY', 'FAQ', 'MEDICINE_LEAFLET', 'CLINICAL_PROTOCOL', 'PHARMACY_PROCEDURE'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const AUDIENCES = ['PATIENT', 'CLINICIAN', 'STAFF'] as const;
export type Audience = (typeof AUDIENCES)[number];

/** Each document type has exactly one audience. Checked at ingest and by a CHECK constraint in the database. */
export const AUDIENCE_OF_TYPE: Record<DocumentType, Audience> = {
  POLICY: 'PATIENT',
  FAQ: 'PATIENT',
  MEDICINE_LEAFLET: 'PATIENT',
  CLINICAL_PROTOCOL: 'CLINICIAN',
  PHARMACY_PROCEDURE: 'STAFF',
};

/**
 * Who may read what. Least privilege: a patient never reads clinician or staff material, and a pharmacist
 * does not read clinician protocols. Admins may read every audience for review.
 */
export const ACCESS_POLICY: Record<Role, { audiences: readonly Audience[]; types: readonly DocumentType[] }> = {
  PATIENT: { audiences: ['PATIENT'], types: ['POLICY', 'FAQ', 'MEDICINE_LEAFLET'] },
  DOCTOR: { audiences: ['PATIENT', 'CLINICIAN'], types: ['POLICY', 'FAQ', 'MEDICINE_LEAFLET', 'CLINICAL_PROTOCOL'] },
  PHARMACIST: { audiences: ['PATIENT', 'STAFF'], types: ['POLICY', 'FAQ', 'MEDICINE_LEAFLET', 'PHARMACY_PROCEDURE'] },
  ADMIN: { audiences: ['PATIENT', 'CLINICIAN', 'STAFF'], types: DOCUMENT_TYPES },
};

/** Indian state name to CarePulse region code. Unknown states use national documents only. */
const STATE_REGION: Record<string, string> = {
  karnataka: 'IN-KA',
  maharashtra: 'IN-MH',
  delhi: 'IN-DL',
  'tamil nadu': 'IN-TN',
  telangana: 'IN-TG',
};

/** National documents (region IN) plus the user's state region, when it is known. */
export function regionsFor(state: string | null | undefined): string[] {
  const code = state ? STATE_REGION[state.trim().toLowerCase()] : undefined;
  return code ? ['IN', code] : ['IN'];
}

/**
 * Initial similarity heuristics from the PRD. They are NOT calibrated for this embedding model or corpus.
 * Re-check them against real questions before relying on them.
 */
export const HIGH_THRESHOLD = 0.8;
export const MEDIUM_THRESHOLD = 0.65;

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

/** HIGH above 0.80, MEDIUM from 0.65 to 0.80, otherwise not covered. */
export function bandOf(score: number): 'HIGH' | 'MEDIUM' | 'NOT_COVERED' {
  if (score > HIGH_THRESHOLD) return 'HIGH';
  if (score >= MEDIUM_THRESHOLD) return 'MEDIUM';
  return 'NOT_COVERED';
}
