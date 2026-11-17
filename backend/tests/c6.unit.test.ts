import { describe, expect, it } from 'vitest';
import { DELIVERY_FEE_PAISE, inrToPaise, paiseToInr, priceOrder } from '../src/modules/commerce/pricing.js';
import { resolveTransition, RULES } from '../src/modules/commerce/order-status.js';
import { addressCreateSchema, cartItemAddSchema, orderCreateSchema } from '../src/modules/commerce/commerce.schemas.js';
import { AppError } from '../src/common/errors/AppError.js';

const line = (inr: number, quantity = 1) => ({ unitPaise: inrToPaise(inr), quantity });

describe('C6 pricing policy', () => {
  it('OTC order at or below INR 299 pays the INR 40 delivery fee and no discount', () => {
    const p = priceOrder([line(280)], false);
    expect(paiseToInr(p.discountPaise)).toBe(0);
    expect(p.deliveryFeePaise).toBe(DELIVERY_FEE_PAISE);
    expect(paiseToInr(p.totalPaise)).toBe(320);
  });

  it('the threshold is strict: exactly INR 299.00 still pays the fee, INR 299.01 gets free delivery', () => {
    expect(priceOrder([line(299)], false).deliveryFeePaise).toBe(4000);
    expect(priceOrder([line(299.01)], false).deliveryFeePaise).toBe(0);
  });

  it('a prescription order gets 10% off and free delivery regardless of subtotal', () => {
    const p = priceOrder([line(118)], true);
    expect(paiseToInr(p.discountPaise)).toBe(11.8);
    expect(p.deliveryFeePaise).toBe(0);
    expect(paiseToInr(p.totalPaise)).toBe(106.2);
    expect(p.explanation.join(' ')).toMatch(/10% discount/);
  });

  it('the 10% discount rounds half-up to the paisa (a discount of 10.5 paise becomes 11 paise)', () => {
    expect(priceOrder([{ unitPaise: 105, quantity: 1 }], true).discountPaise).toBe(11);
    expect(priceOrder([{ unitPaise: 50, quantity: 1 }], true).discountPaise).toBe(5);
  });

  it('totals always add up: subtotal - discount + delivery', () => {
    for (const inr of [1, 33.33, 150, 299, 300, 999.99]) {
      for (const rx of [true, false]) {
        const p = priceOrder([line(inr, 3)], rx);
        expect(p.totalPaise).toBe(p.subtotalPaise - p.discountPaise + p.deliveryFeePaise);
      }
    }
  });

  it('the explanation names every component that was charged', () => {
    const p = priceOrder([line(400)], false);
    expect(p.explanation.some((s) => /Free delivery on orders above INR 299/.test(s))).toBe(true);
    expect(p.explanation.at(-1)).toBe('Total: INR 400.00');
  });
});

describe('C6 order lifecycle', () => {
  it('the happy path is the only forward path', () => {
    expect(resolveTransition('PLACED', 'verify', 'PHARMACIST', null).to).toBe('VERIFIED');
    expect(resolveTransition('VERIFIED', 'pack', 'PHARMACIST', null).to).toBe('PACKED');
    expect(resolveTransition('PACKED', 'dispatch', 'PHARMACIST', null).to).toBe('OUT_FOR_DELIVERY');
    expect(resolveTransition('OUT_FOR_DELIVERY', 'deliver', 'PHARMACIST', null).to).toBe('DELIVERED');
  });

  it('skipping a step is an invalid transition', () => {
    expect(() => resolveTransition('PLACED', 'pack', 'PHARMACIST', null)).toThrow(AppError);
    expect(() => resolveTransition('PLACED', 'deliver', 'PHARMACIST', null)).toThrow(/Cannot deliver/);
  });

  it('terminal states allow nothing', () => {
    for (const s of ['DELIVERED', 'REJECTED', 'CANCELLED'] as const) {
      for (const action of Object.keys(RULES) as (keyof typeof RULES)[]) {
        expect(() => resolveTransition(s, action, 'PHARMACIST', 'reason here')).toThrow(AppError);
      }
    }
  });

  it('rejection needs a reason; cancellation is patient-only', () => {
    expect(() => resolveTransition('PLACED', 'reject', 'PHARMACIST', null)).toThrow(/reason/i);
    expect(() => resolveTransition('PLACED', 'cancel', 'PHARMACIST', null)).toThrow(/not available/);
    expect(() => resolveTransition('PLACED', 'verify', 'PATIENT', null)).toThrow(/not available/);
    expect(resolveTransition('PLACED', 'cancel', 'PATIENT', null).restoresStock).toBe(true);
  });

  it('only rejection and cancellation restore stock', () => {
    expect(RULES.reject.restoresStock).toBe(true);
    expect(RULES.cancel.restoresStock).toBe(true);
    expect(RULES.verify.restoresStock).toBe(false);
    expect(RULES.deliver.restoresStock).toBe(false);
  });
});

describe('C6 request schemas refuse client-supplied money and stock', () => {
  it('order creation accepts only an address and a payment method', () => {
    const ok = orderCreateSchema.safeParse({ addressId: '6f1c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6', paymentMethod: 'COD' });
    expect(ok.success).toBe(true);
    for (const tampered of [{ total: 1 }, { totalInr: 1 }, { discount: 100 }, { unitPrice: 1 }, { stock: 999 }]) {
      const r = orderCreateSchema.safeParse({ addressId: '6f1c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6', paymentMethod: 'COD', ...tampered });
      expect(r.success).toBe(false);
    }
  });

  it('cart add refuses a client price and out-of-range quantities', () => {
    const id = '6f1c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6';
    expect(cartItemAddSchema.safeParse({ medicineId: id, quantity: 2, price: 1 }).success).toBe(false);
    expect(cartItemAddSchema.safeParse({ medicineId: id, quantity: 0 }).success).toBe(false);
    expect(cartItemAddSchema.safeParse({ medicineId: id, quantity: 101 }).success).toBe(false);
  });

  it('addresses need a valid 6-digit pincode', () => {
    const base = { label: 'Home', line: '12 Lake Road', city: 'Pune', state: 'Maharashtra' };
    expect(addressCreateSchema.safeParse({ ...base, pincode: '411004' }).success).toBe(true);
    expect(addressCreateSchema.safeParse({ ...base, pincode: '011004' }).success).toBe(false);
    expect(addressCreateSchema.safeParse({ ...base, pincode: '41100' }).success).toBe(false);
  });
});
