import { AppError } from '../../common/errors/AppError.js';

/**
 * The single place where order lifecycle rules live. Anything not listed here is refused.
 *
 *   PLACED -> VERIFIED -> PACKED -> OUT_FOR_DELIVERY -> DELIVERED
 *   PLACED | VERIFIED -> REJECTED   (pharmacist, reason required, stock restored)
 *   PLACED -> CANCELLED             (patient, stock restored)
 *
 * DELIVERED, REJECTED and CANCELLED are terminal.
 */
export const ORDER_STATUSES = ['PLACED', 'VERIFIED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'REJECTED', 'CANCELLED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type OrderAction = 'verify' | 'pack' | 'dispatch' | 'deliver' | 'reject' | 'cancel';
export type OrderActor = 'PATIENT' | 'PHARMACIST';

export interface TransitionRule {
  from: OrderStatus[];
  to: OrderStatus;
  actors: OrderActor[];
  reasonRequired: boolean;
  /** Column that records when the transition happened. */
  stamp: 'verified_at' | 'packed_at' | 'dispatched_at' | 'delivered_at' | 'rejected_at' | 'cancelled_at';
  restoresStock: boolean;
}

export const RULES: Record<OrderAction, TransitionRule> = {
  verify: { from: ['PLACED'], to: 'VERIFIED', actors: ['PHARMACIST'], reasonRequired: false, stamp: 'verified_at', restoresStock: false },
  pack: { from: ['VERIFIED'], to: 'PACKED', actors: ['PHARMACIST'], reasonRequired: false, stamp: 'packed_at', restoresStock: false },
  dispatch: { from: ['PACKED'], to: 'OUT_FOR_DELIVERY', actors: ['PHARMACIST'], reasonRequired: false, stamp: 'dispatched_at', restoresStock: false },
  deliver: { from: ['OUT_FOR_DELIVERY'], to: 'DELIVERED', actors: ['PHARMACIST'], reasonRequired: false, stamp: 'delivered_at', restoresStock: false },
  reject: { from: ['PLACED', 'VERIFIED'], to: 'REJECTED', actors: ['PHARMACIST'], reasonRequired: true, stamp: 'rejected_at', restoresStock: true },
  cancel: { from: ['PLACED'], to: 'CANCELLED', actors: ['PATIENT'], reasonRequired: false, stamp: 'cancelled_at', restoresStock: true },
};

/** Validates one transition and returns its rule. Throws AppError for every refusal. */
export function resolveTransition(current: OrderStatus, action: OrderAction, actor: OrderActor, reason: string | null): TransitionRule {
  const rule = RULES[action];
  if (!rule.actors.includes(actor)) {
    throw new AppError(403, 'FORBIDDEN_TRANSITION', `This action is not available to you`);
  }
  if (!rule.from.includes(current)) {
    throw new AppError(409, 'INVALID_TRANSITION', `Cannot ${action} an order that is ${current.toLowerCase().replace(/_/g, ' ')}`);
  }
  if (rule.reasonRequired && !reason) {
    throw new AppError(422, 'REASON_REQUIRED', 'Give a reason for this action', [{ path: 'reason', message: 'Required' }]);
  }
  return rule;
}

export const isTerminal = (s: OrderStatus): boolean => s === 'DELIVERED' || s === 'REJECTED' || s === 'CANCELLED';
