/**
 * CarePulse fictional commerce policy. Every amount is integer paise inside the calculation, so there is no
 * floating-point drift. Half-paise round up (half-up). The same function prices the cart, the checkout and the
 * stored order, so the numbers shown to the patient are the numbers that are charged.
 *
 *   subtotal        = sum(unit price x quantity), at current catalogue prices
 *   discount        = 10% of subtotal on a prescription order (rounded half-up), otherwise 0
 *   delivery fee    = 0 for a prescription order, or when the subtotal is above INR 299.00,
 *                     otherwise INR 40.00
 *   total           = subtotal - discount + delivery fee
 *
 * The threshold is tested against the subtotal before the discount.
 */
export const DELIVERY_FEE_PAISE = 4000;
export const FREE_DELIVERY_ABOVE_PAISE = 29900; // strictly above INR 299.00
export const PRESCRIPTION_DISCOUNT_PERCENT = 10;

export interface PricedLine {
  unitPaise: number;
  quantity: number;
}

export interface PriceBreakdown {
  subtotalPaise: number;
  discountPaise: number;
  deliveryFeePaise: number;
  totalPaise: number;
  isPrescriptionOrder: boolean;
  freeDelivery: boolean;
  explanation: string[];
}

/** Half-up division for non-negative integers: round(numerator / denominator). */
const divRoundHalfUp = (numerator: number, denominator: number): number => Math.floor((numerator * 2 + denominator) / (denominator * 2));

export const inrToPaise = (value: number | string): number => Math.round(Number(value) * 100);
export const paiseToInr = (paise: number): number => Number((paise / 100).toFixed(2));

export function priceOrder(lines: PricedLine[], isPrescriptionOrder: boolean): PriceBreakdown {
  const subtotalPaise = lines.reduce((sum, l) => sum + l.unitPaise * l.quantity, 0);
  const itemCount = lines.reduce((sum, l) => sum + l.quantity, 0);
  return finish(subtotalPaise, isPrescriptionOrder, itemCount);
}

/** Recomputes a breakdown from stored totals, so a stored order can explain itself without the cart. */
export function explainStored(subtotalPaise: number, isPrescriptionOrder: boolean, itemCount: number): PriceBreakdown {
  return finish(subtotalPaise, isPrescriptionOrder, itemCount);
}

function finish(subtotalPaise: number, isPrescriptionOrder: boolean, itemCount: number): PriceBreakdown {
  const discountPaise = isPrescriptionOrder ? divRoundHalfUp(subtotalPaise * PRESCRIPTION_DISCOUNT_PERCENT, 100) : 0;
  const freeDelivery = isPrescriptionOrder || subtotalPaise > FREE_DELIVERY_ABOVE_PAISE;
  const deliveryFeePaise = freeDelivery ? 0 : DELIVERY_FEE_PAISE;
  const totalPaise = subtotalPaise - discountPaise + deliveryFeePaise;

  const rupees = (p: number) => `INR ${(p / 100).toFixed(2)}`;
  const explanation = [`Subtotal: ${itemCount} ${itemCount === 1 ? 'item' : 'items'} at current prices, ${rupees(subtotalPaise)}`];
  if (isPrescriptionOrder) {
    explanation.push(`CarePulse prescription order: ${PRESCRIPTION_DISCOUNT_PERCENT}% discount, -${rupees(discountPaise)}`);
    explanation.push('Free delivery on prescription orders');
  } else if (freeDelivery) {
    explanation.push('Free delivery on orders above INR 299');
  } else {
    explanation.push(`Delivery fee ${rupees(DELIVERY_FEE_PAISE)} (orders of INR 299 or less)`);
  }
  explanation.push(`Total: ${rupees(totalPaise)}`);

  return { subtotalPaise, discountPaise, deliveryFeePaise, totalPaise, isPrescriptionOrder, freeDelivery, explanation };
}
