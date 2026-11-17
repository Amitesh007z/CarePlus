import { z } from 'zod';
import { pageQuery } from '../../common/http.js';

const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

export const catalogueQuery = pageQuery.extend({
  q: z.string().trim().max(80).optional(),
  category: z.string().trim().max(40).optional(),
  rx: z.enum(['all', 'rx', 'otc']).default('all'),
  minPrice: z.coerce.number().min(0).max(100000).optional(),
  maxPrice: z.coerce.number().min(0).max(100000).optional(),
  inStock: z.enum(['true', 'false']).optional(),
  sort: z.enum(['relevance', 'name', 'price_asc', 'price_desc']).optional(),
}).refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice, {
  message: 'minPrice cannot be greater than maxPrice',
  path: ['minPrice'],
});
export type CatalogueQuery = z.infer<typeof catalogueQuery>;

const medicineFields = {
  sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,32}$/, 'Use 3-32 letters, digits or hyphens'),
  name: z.string().trim().min(2, 'Enter the medicine name').max(160),
  strength: optText(40),
  form: z.string().trim().min(2).max(40),
  category: z.string().trim().min(2).max(40),
  packSize: z.string().trim().min(2).max(60),
  priceInr: z.number().min(0).max(100000),
  rxRequired: z.boolean(),
  allergyClass: optText(60),
  description: optText(1000),
  manufacturer: optText(120),
  chronicEligible: z.boolean(),
};

/** Stock is never set directly on a medicine: it changes only through the stock ledger. */
export const medicineCreateSchema = z
  .object({ ...medicineFields, initialStock: z.number().int().min(0).max(100000).default(0), active: z.boolean().default(true) })
  .strict();
export const medicineUpdateSchema = z
  .object({ ...medicineFields, active: z.boolean() })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type MedicineCreate = z.infer<typeof medicineCreateSchema>;
export type MedicineUpdate = z.infer<typeof medicineUpdateSchema>;

export const adminMedicineQuery = pageQuery.extend({
  q: z.string().trim().max(80).optional(),
  active: z.enum(['true', 'false', 'all']).default('all'),
});

export const interactionCreateSchema = z
  .object({
    medicineAId: z.uuid(),
    medicineBId: z.uuid(),
    severity: z.enum(['MAJOR', 'MODERATE', 'MINOR']),
    effect: z.string().trim().min(5).max(300),
    sourceReference: z.string().trim().min(3, 'Cite the source of this rule').max(200),
  })
  .strict()
  .refine((v) => v.medicineAId !== v.medicineBId, { message: 'A medicine cannot interact with itself', path: ['medicineBId'] });
export type InteractionCreate = z.infer<typeof interactionCreateSchema>;
