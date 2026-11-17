import type { Queryable } from '../../../infrastructure/database/pool.js';
import { ageFromDob } from '../../auth/user.repository.js';
import { availabilityOf, type Availability } from '../../medicines/catalogue.service.js';
import { matchAllergies } from '../../prescriptions/prescriptions.service.js';

/** The minimum patient context the assistant needs. No conditions, medications or contact details. */
export interface CareContext {
  consent: boolean;
  age: number | null;
  allergies: { name: string; allergyClass: string | null }[];
}

export async function loadCareContext(db: Queryable, userId: string, now = new Date()): Promise<CareContext> {
  const p = await db.query<{ consent_status: boolean; dob: string | null }>(
    `SELECT consent_status, to_char(dob, 'YYYY-MM-DD') AS dob FROM patient_profiles WHERE user_id = $1`,
    [userId],
  );
  const profile = p.rows[0];
  // Allergies are needed only for the deterministic allergy filter, so only active ALLERGY rows are read.
  const a = profile?.consent_status
    ? await db.query<{ name: string; allergy_class: string | null }>(
        `SELECT name, allergy_class FROM health_info WHERE patient_user_id = $1 AND type = 'ALLERGY' AND active`,
        [userId],
      )
    : { rows: [] };
  return {
    consent: profile?.consent_status === true,
    age: profile?.dob ? ageFromDob(profile.dob, now) : null,
    allergies: a.rows.map((r) => ({ name: r.name, allergyClass: r.allergy_class })),
  };
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const patterns = (keywords: string[]): string[] => keywords.map((k) => `%${escapeLike(k)}%`);

export interface DoctorCandidate {
  id: string;
  displayName: string;
  specialty: string;
  experienceYears: number;
}

/** Active doctors whose specialty matches a keyword; otherwise general-practice doctors. Capped. */
export async function findDoctorCandidates(db: Queryable, keywords: string[]): Promise<DoctorCandidate[]> {
  const base = `FROM doctor_profiles d JOIN users u ON u.id = d.user_id WHERE d.active AND u.status = 'ACTIVE'`;
  const cols = `SELECT d.user_id AS id, d.display_name, d.specialty, d.experience_years ${base}`;
  const matched = keywords.length
    ? await db.query<Row>(`${cols} AND d.specialty ILIKE ANY($1::text[]) ORDER BY d.display_name LIMIT 5`, [patterns(keywords)])
    : { rows: [] as Row[] };
  const rows = matched.rows.length
    ? matched.rows
    : (
        await db.query<Row>(
          `${cols} AND d.specialty ILIKE ANY($1::text[]) ORDER BY d.display_name LIMIT 5`,
          [['%general%', '%family%', '%internal%']],
        )
      ).rows;
  return rows.map((r) => ({ id: r.id, displayName: r.display_name, specialty: r.specialty, experienceYears: r.experience_years }));
}

interface Row {
  id: string;
  display_name: string;
  specialty: string;
  experience_years: number;
}

export interface ProductCandidate {
  id: string;
  sku: string;
  name: string;
  strength: string | null;
  form: string;
  category: string;
  priceInr: number;
  stockQty: number;
  rxRequired: boolean;
  allergyClass: string | null;
  availability: Availability;
}

/**
 * Active, OTC, in-stock medicines matching the keywords. Rx-only and out-of-stock items never reach the
 * model; the rx filter is repeated in code by the caller as defence in depth.
 */
export async function findProductCandidates(db: Queryable, keywords: string[]): Promise<ProductCandidate[]> {
  if (keywords.length === 0) return [];
  const r = await db.query<{
    id: string;
    sku: string;
    name: string;
    strength: string | null;
    form: string;
    category: string;
    price_inr: string;
    stock_qty: number;
    rx_required: boolean;
    allergy_class: string | null;
  }>(
    `SELECT id, sku, name, strength, form, category, price_inr, stock_qty, rx_required, allergy_class
       FROM medicines
      WHERE active AND NOT rx_required AND stock_qty > 0
        AND (name ILIKE ANY($1::text[]) OR category ILIKE ANY($1::text[]) OR coalesce(description, '') ILIKE ANY($1::text[]))
      ORDER BY name ASC LIMIT 30`,
    [patterns(keywords)],
  );
  return r.rows.map((x) => ({
    id: x.id,
    sku: x.sku,
    name: x.name,
    strength: x.strength,
    form: x.form,
    category: x.category,
    priceInr: Number(x.price_inr),
    stockQty: x.stock_qty,
    rxRequired: x.rx_required,
    allergyClass: x.allergy_class,
    availability: availabilityOf(x.stock_qty),
  }));
}

/**
 * Deterministic allergy filter. Returns the candidates that survive, plus the SKUs removed (for logs/tests).
 * The model never sees removed items and cannot restore them.
 */
export function removeAllergyConflicts(
  products: ProductCandidate[],
  allergies: CareContext['allergies'],
): { kept: ProductCandidate[]; removedSkus: string[] } {
  if (allergies.length === 0) return { kept: products.filter((p) => !p.rxRequired), removedSkus: [] };
  const conflicts = new Set(
    matchAllergies(
      products.map((p) => ({ sku: p.sku, name: p.name, allergyClass: p.allergyClass })),
      allergies,
    ).map((m) => m.medicineSku),
  );
  return {
    kept: products.filter((p) => !p.rxRequired && !conflicts.has(p.sku)),
    removedSkus: [...conflicts],
  };
}
