export type RxStatus = 'DRAFT' | 'ISSUED' | 'FULFILLED' | 'SUPERSEDED' | 'EXPIRED';

export interface AllergyMatch {
  medicineSku: string;
  medicineName: string;
  allergyClass: string;
  matchedOn: 'ALLERGY_CLASS' | 'ALLERGY_NAME';
}

export interface RxItem {
  id: string;
  lineNo: number;
  medicine: { id: string; sku: string; name: string; strength: string | null };
  allergyClass: string | null;
  dose: string;
  frequency: string;
  durationDays: number;
  instructions: string | null;
  quantity: number;
}

export interface Prescription {
  id: string;
  rxNumber: string | null;
  status: RxStatus;
  consultationId: string;
  patient: { id: string; name: string; age: number };
  doctor: { id: string; name: string; specialty: string; registrationNo: string };
  advice: string | null;
  issuedAt: string | null;
  validTill: string | null;
  fulfilledAt: string | null;
  replacesId: string | null;
  supersededById: string | null;
  items: RxItem[];
  allergyCheck: { policy: string; matches: AllergyMatch[]; checkedAt: string } | null;
  validityDays: 30 | 90;
  checks: {
    allergyMatches: AllergyMatch[];
    interactions: DrugInteraction[];
    notChronicEligible: { id: string; name: string }[];
    blockers: string[];
    canIssue: boolean;
  } | null;
}

export interface DrugInteraction {
  severity: 'MAJOR' | 'MODERATE' | 'MINOR';
  effect: string;
  sourceReference: string;
  medicines: { id: string; name: string }[];
}

export interface PrescriptionSummary {
  id: string;
  rxNumber: string | null;
  status: RxStatus;
  issuedAt: string | null;
  validTill: string | null;
  doctor: { name: string; specialty: string };
  itemCount: number;
}

export interface MedicineOption {
  id: string;
  sku: string;
  name: string;
  strength: string | null;
  form: string;
  packSize: string;
  priceInr: number;
  rxRequired: boolean;
  allergyClass: string | null;
}

export const RX_STATUS_STYLE: Record<RxStatus, { label: string; tone: string }> = {
  DRAFT: { label: 'Draft', tone: 'bg-slate-100 text-slate-700 ring-slate-200' },
  ISSUED: { label: 'Issued', tone: 'bg-emerald-100 text-emerald-800 ring-emerald-200' },
  FULFILLED: { label: 'Fulfilled', tone: 'bg-sky-100 text-sky-800 ring-sky-200' },
  SUPERSEDED: { label: 'Replaced', tone: 'bg-amber-100 text-amber-900 ring-amber-200' },
  EXPIRED: { label: 'Expired', tone: 'bg-rose-100 text-rose-800 ring-rose-200' },
};
