/** Commerce contract from the API. The server computes every price, discount, fee and total; the browser only displays them. */

export type OrderStatus = 'PLACED' | 'VERIFIED' | 'PACKED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'REJECTED' | 'CANCELLED';
export type PaymentMethod = 'MOCK_CARD' | 'COD';
export type PaymentStatus = 'SUCCEEDED' | 'PENDING' | 'COLLECTED' | 'REFUNDED';

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  PLACED: 'Placed',
  VERIFIED: 'Verified by pharmacist',
  PACKED: 'Packed',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  REJECTED: 'Not dispensed',
  CANCELLED: 'Cancelled',
};

export const ORDER_STATUS_TONE: Record<OrderStatus, string> = {
  PLACED: 'bg-amber-50 text-amber-900 ring-amber-200',
  VERIFIED: 'bg-teal-50 text-teal-900 ring-teal-200',
  PACKED: 'bg-indigo-50 text-indigo-900 ring-indigo-200',
  OUT_FOR_DELIVERY: 'bg-sky-50 text-sky-900 ring-sky-200',
  DELIVERED: 'bg-emerald-50 text-emerald-900 ring-emerald-200',
  REJECTED: 'bg-rose-50 text-rose-900 ring-rose-200',
  CANCELLED: 'bg-slate-100 text-slate-700 ring-slate-300',
};

export const PAYMENT_LABEL: Record<PaymentStatus, string> = {
  SUCCEEDED: 'Paid (simulated card)',
  PENDING: 'Pay on delivery',
  COLLECTED: 'Collected on delivery',
  REFUNDED: 'Refunded',
};

export interface Address {
  id: string;
  label: string;
  line: string;
  city: string;
  state: string;
  pincode: string;
  isDefault: boolean;
}

export interface CartMedicine {
  id: string;
  sku: string;
  name: string;
  strength: string | null;
  packSize: string;
  rxRequired: boolean;
  availability: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';
}

export interface CartLine {
  id: string;
  quantity: number;
  source: 'CATALOGUE' | 'PRESCRIPTION';
  /** Prescription lines are exact: their quantity cannot be changed in the cart. */
  locked: boolean;
  prescription: { id: string; rxNumber: string | null } | null;
  medicine: CartMedicine;
  unitPriceInr: number;
  lineTotalInr: number;
  problems: string[];
}

export interface Summary {
  subtotalInr: number;
  discountInr: number;
  deliveryFeeInr: number;
  totalInr: number;
  isPrescriptionOrder: boolean;
  freeDelivery: boolean;
  explanation: string[];
}

export interface Cart {
  items: CartLine[];
  summary: Summary;
  blockers: string[];
}

export interface OrderSummary {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  totalInr: number;
  placedAt: string;
  itemCount: number;
  isPrescriptionOrder: boolean;
}

export interface OrderItem {
  lineNo: number;
  name: string;
  sku: string;
  strength: string | null;
  packSize: string;
  unitPriceInr: number;
  quantity: number;
  lineTotalInr: number;
  rxRequired: boolean;
  prescriptionRxNumber: string | null;
}

export interface Order {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  isPrescriptionOrder: boolean;
  placedAt: string;
  items: OrderItem[];
  subtotalInr: number;
  discountInr: number;
  deliveryFeeInr: number;
  totalInr: number;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  address: { label: string; line: string; city: string; state: string; pincode: string };
  timeline: {
    placedAt: string;
    verifiedAt: string | null;
    packedAt: string | null;
    dispatchedAt: string | null;
    deliveredAt: string | null;
    rejectedAt: string | null;
    cancelledAt: string | null;
  };
  statusReason: string | null;
  explanation: string[];
  /** Present on the response of a retried placement. True means no new order was created. */
  replayed?: boolean;
}

export interface PharmacyOrderSummary extends OrderSummary {
  patientName: string;
}

export interface OrderEventView {
  action: string;
  fromStatus: string | null;
  toStatus: string;
  actorRole: string;
  reason: string | null;
  at: string;
}

export interface PharmacyOrder extends Order {
  patient: { name: string };
  /** id links to the prescription review page; it is optional until the server returns it. */
  prescriptions: { id?: string; rxNumber: string | null; validTill: string | null }[];
  events?: OrderEventView[];
}

export type PharmacyOrderAction = 'verify' | 'pack' | 'dispatch' | 'deliver' | 'reject';

/** Money formatter. Display only: the numbers come from the server. */
export const inr = (value: number): string => `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
