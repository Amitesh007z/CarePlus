import type { Queryable } from '../../infrastructure/database/pool.js';

/**
 * Synthetic catalogue from the brief (fictional prices, no clinical content). Names, pack sizes, prices and
 * Rx/OTC flags are the brief's. `category` is a therapeutic grouping used for the catalogue filter.
 * Stock is demo-only and changes only through the pharmacy stock ledger.
 */
export const MEDICINE_SEED = [
  { sku: 'MED-1001', name: 'Azithromycin 500 mg tablet', strength: '500 mg', form: 'Tablet', category: 'Antibiotic', packSize: 'Strip of 3', priceInr: 118, rxRequired: true, allergyClass: 'Macrolide' },
  { sku: 'MED-1002', name: 'Amoxicillin 500 mg capsule', strength: '500 mg', form: 'Capsule', category: 'Antibiotic', packSize: 'Strip of 10', priceInr: 96, rxRequired: true, allergyClass: 'Penicillin' },
  { sku: 'MED-1003', name: 'Montelukast 10 mg tablet', strength: '10 mg', form: 'Tablet', category: 'Respiratory', packSize: 'Strip of 7', priceInr: 165, rxRequired: true, allergyClass: null },
  { sku: 'MED-1004', name: 'Salbutamol inhaler 100 mcg', strength: '100 mcg', form: 'Inhaler', category: 'Respiratory', packSize: '200 doses', priceInr: 155, rxRequired: true, allergyClass: null },
  { sku: 'MED-1005', name: 'Dextromethorphan syrup', strength: null, form: 'Syrup', category: 'Cough and cold', packSize: '100 ml bottle', priceInr: 92, rxRequired: false, allergyClass: null },
  { sku: 'MED-1006', name: 'Paracetamol 650 mg tablet', strength: '650 mg', form: 'Tablet', category: 'Pain and fever', packSize: 'Strip of 15', priceInr: 32, rxRequired: false, allergyClass: null },
  { sku: 'MED-1007', name: 'Cetirizine 10 mg tablet', strength: '10 mg', form: 'Tablet', category: 'Allergy', packSize: 'Strip of 10', priceInr: 28, rxRequired: false, allergyClass: null },
  { sku: 'MED-1008', name: 'Vitamin D3 60,000 IU capsule', strength: '60,000 IU', form: 'Capsule', category: 'Vitamins', packSize: 'Pack of 4', priceInr: 140, rxRequired: false, allergyClass: null },
] as const;

/** Idempotent: existing SKUs are left untouched, so re-seeding never overwrites catalogue edits. */
export async function upsertMedicineSeed(db: Queryable): Promise<number> {
  let inserted = 0;
  for (const m of MEDICINE_SEED) {
    const r = await db.query(
      `INSERT INTO medicines (sku, name, strength, form, category, pack_size, price_inr, stock_qty, rx_required, allergy_class)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 100, $8, $9)
       ON CONFLICT (sku) DO NOTHING`,
      [m.sku, m.name, m.strength, m.form, m.category, m.packSize, m.priceInr, m.rxRequired, m.allergyClass],
    );
    inserted += r.rowCount ?? 0;
  }
  return inserted;
}
