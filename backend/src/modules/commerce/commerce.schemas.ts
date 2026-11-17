import { z } from 'zod';

/**
 * Every write schema is strict. A client cannot send a price, subtotal, discount, total, stock figure,
 * prescription item or status: any extra field is a validation error, not a silent override.
 */
export const addressCreateSchema = z
  .object({
    label: z.string().trim().min(1, 'Name this address').max(30),
    line: z.string().trim().min(5, 'Enter the full address').max(200),
    city: z.string().trim().min(2).max(60),
    state: z.string().trim().min(2).max(60),
    pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'Enter a 6-digit pincode'),
    isDefault: z.boolean().optional(),
  })
  .strict();

export const cartItemAddSchema = z
  .object({
    medicineId: z.uuid({ message: 'Choose a medicine' }),
    quantity: z.number().int('Quantity must be a whole number').min(1).max(100),
  })
  .strict();

export const cartItemPatchSchema = z.object({ quantity: z.number().int().min(1).max(100) }).strict();

export const orderCreateSchema = z
  .object({
    addressId: z.uuid({ message: 'Choose a delivery address' }),
    paymentMethod: z.enum(['MOCK_CARD', 'COD']),
  })
  .strict();

export const orderCancelSchema = z.object({ reason: z.string().trim().min(3).max(300).optional() }).strict();

export const pharmacyOrderActionSchema = z
  .object({
    action: z.enum(['verify', 'pack', 'dispatch', 'deliver', 'reject']),
    reason: z.string().trim().min(3, 'Give a reason').max(300).optional(),
  })
  .strict();

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;
