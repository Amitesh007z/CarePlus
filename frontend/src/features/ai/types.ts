// Mirrors backend/src/modules/ai/care/care.schemas.ts (CareResponse). Keep in sync with the backend contract.
export type CareUrgency = 'SELF_CARE' | 'SEE_DOCTOR' | 'EMERGENCY';
export type Availability = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';

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
  requiresConfirmation: true;
}

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
