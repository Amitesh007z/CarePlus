import { z } from 'zod';

const itemFields = {
  medicineId: z.uuid({ message: 'Choose a medicine from the catalogue' }),
  dose: z.string().trim().min(1, 'Enter the dose').max(60),
  frequency: z.string().trim().min(1, 'Enter how often').max(60),
  durationDays: z.number().int('Duration must be whole days').min(1, 'Duration must be at least 1 day').max(365, 'Duration cannot exceed 365 days'),
  quantity: z.number().int('Quantity must be a whole number').min(1, 'Quantity must be at least 1').max(100, 'Quantity cannot exceed 100'),
  instructions: z.string().trim().max(300).nullish(),
};

/** Strict: a client cannot set prices, stock, status, allergy class or the prescription number. */
export const itemCreateSchema = z.object(itemFields).strict();
export const itemUpdateSchema = z
  .object(itemFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type ItemCreate = z.infer<typeof itemCreateSchema>;
export type ItemUpdate = z.infer<typeof itemUpdateSchema>;

export const headerUpdateSchema = z.object({ advice: z.string().trim().max(500).nullable() }).strict();

export const medicineSearchQuery = z.object({
  query: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
