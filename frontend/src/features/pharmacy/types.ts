import type { Availability } from '../catalogue/types';

export type FulfilmentStatus = 'QUEUED' | 'VERIFIED' | 'PACKED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'REJECTED';
export type FulfilmentAction = 'verify' | 'pack' | 'dispatch' | 'deliver' | 'reject';

export const FULFILMENT_LABEL: Record<FulfilmentStatus, string> = {
  QUEUED: 'Waiting to check',
  VERIFIED: 'Checked',
  PACKED: 'Packed',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  REJECTED: 'Rejected',
};

export const FULFILMENT_TONE: Record<FulfilmentStatus, string> = {
  QUEUED: 'bg-amber-50 text-amber-900 ring-amber-200',
  VERIFIED: 'bg-teal-50 text-teal-900 ring-teal-200',
  PACKED: 'bg-indigo-50 text-indigo-900 ring-indigo-200',
  OUT_FOR_DELIVERY: 'bg-sky-50 text-sky-900 ring-sky-200',
  DELIVERED: 'bg-emerald-50 text-emerald-900 ring-emerald-200',
  REJECTED: 'bg-rose-50 text-rose-900 ring-rose-200',
};

export interface QueueItem {
  id: string;
  status: FulfilmentStatus;
  requestedAt: string;
  rxNumber: string | null;
  patientName: string;
  doctorName: string;
  itemCount: number;
}

export interface FulfilmentDetail {
  id: string;
  status: FulfilmentStatus;
  prescription: {
    id: string;
    rxNumber: string | null;
    status: string;
    validTill: string | null;
    patient: { name: string; dob: string };
    doctor: { name: string; registrationNo: string };
  };
  items: {
    lineNo: number;
    medicineId: string;
    name: string;
    strength: string | null;
    dose: string;
    frequency: string;
    durationDays: number;
    quantity: number;
    instructions: string | null;
    stockOnHand: number;
    availability: Availability;
  }[];
  canPack: boolean;
  shortfalls: { medicineId: string; name: string; needed: number; available: number }[];
  timeline: {
    requestedAt: string;
    verifiedAt: string | null;
    packedAt: string | null;
    dispatchedAt: string | null;
    deliveredAt: string | null;
    rejectedAt: string | null;
  };
  rejectionReason: string | null;
}

export interface StockRow {
  id: string;
  sku: string;
  name: string;
  stockOnHand: number;
  active: boolean;
  availability: Availability;
}

export interface Movement {
  delta: number;
  balanceAfter: number;
  reason: 'ADJUSTMENT' | 'DISPENSE';
  note: string | null;
  fulfilmentId: string | null;
  createdAt: string;
}
