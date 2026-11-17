import { z } from 'zod';
import type { Availability } from '../../medicines/catalogue.service.js';

export const careRequestSchema = z.strictObject({
  message: z.string().trim().min(1, 'Describe what you need help with').max(500, 'Keep the message under 500 characters'),
});

const keyword = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z -]{1,29}$/, 'keyword must be letters and spaces');

/** Output of the extraction call. Facts only: what the patient needs, for how long, and what limits apply. */
export const extractionSchema = z.strictObject({
  need: z.string().trim().min(2).max(120).nullable(),
  durationDays: z.number().int().min(0).max(3650).nullable(),
  constraints: z.array(z.string().trim().min(1).max(60)).max(5),
  keywords: z.array(keyword).max(5),
});
export type Extraction = z.infer<typeof extractionSchema>;

const reason = z.string().trim().min(1).max(200);

/**
 * Output of the ranking call. IDs must come from the candidate list (checked in code, not here).
 * No price, stock, Rx or allergy fields exist, so the model has no place to put them.
 */
export const rankingSchema = z.strictObject({
  summary: z.string().trim().min(1).max(400),
  urgency: z.enum(['SELF_CARE', 'SEE_DOCTOR']),
  doctors: z.array(z.strictObject({ id: z.uuid(), reason })).max(3),
  products: z.array(z.strictObject({ id: z.uuid(), reason })).max(3),
});
export type Ranking = z.infer<typeof rankingSchema>;

export type CareUrgency = 'SELF_CARE' | 'SEE_DOCTOR' | 'EMERGENCY';

export interface RecommendedDoctor {
  id: string;
  displayName: string;
  specialty: string;
  experienceYears: number;
  reason: string;
}

export interface RecommendedProduct {
  id: string;
  sku: string;
  name: string;
  strength: string | null;
  form: string;
  priceInr: number;
  availability: Availability;
  rxRequired: false;
  reason: string;
  /** Adding to cart always needs the patient's explicit confirmation in the UI. */
  requiresConfirmation: true;
}

/** Typed response contract for AI-A (the care assistant). */
export interface CareResponse {
  urgency: CareUrgency;
  summary: string;
  clarificationRequired: boolean;
  clarificationQuestion: string | null;
  recommendedDoctors: RecommendedDoctor[];
  recommendedProducts: RecommendedProduct[];
  safetyMessage: string;
  disclaimer: string;
  followUpRequired: boolean;
}

export type { Availability };
