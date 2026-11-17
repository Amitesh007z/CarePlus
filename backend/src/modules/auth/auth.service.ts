import { AppError } from '../../common/errors/AppError.js';
import type { Database, Queryable } from '../../infrastructure/database/pool.js';
import type { PasswordHasher } from './password.js';
import { normalizeEmail, normalizeMobile, type LoginInput, type RegisterInput } from './validation.js';

interface PgError {
  code?: string;
  constraint?: string;
}

/** Registration always creates a PATIENT; there is no role parameter anywhere in this path. */
export async function registerPatient(db: Database, hasher: PasswordHasher, input: RegisterInput): Promise<string> {
  const passwordHash = await hasher.hash(input.password); // outside the transaction: hashing is slow
  try {
    return await db.transaction(async (tx) => {
      const user = await tx.query<{ id: string }>(
        `INSERT INTO users (role, email, mobile, password_hash) VALUES ('PATIENT', $1, $2, $3) RETURNING id`,
        [input.email, input.mobile, passwordHash],
      );
      const id = user.rows[0]!.id;
      await tx.query(
        `INSERT INTO patient_profiles
           (user_id, full_name, dob, gender, blood_group, address_line, city, state, pincode,
            emergency_contact_name, emergency_contact_phone, consent_status, consent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,now())`,
        [
          id, input.fullName, input.dob, input.gender, input.bloodGroup, input.addressLine, input.city,
          input.state, input.pincode, input.emergencyContactName, input.emergencyContactPhone,
        ],
      );
      return id;
    });
  } catch (err) {
    const e = err as PgError;
    // The database uniqueness constraints are the source of truth, which closes the check-then-insert race.
    if (e.code === '23505') {
      const field = e.constraint?.includes('mobile') ? 'mobile' : 'email';
      throw new AppError(409, 'CONFLICT', 'An account with these details already exists', [
        { path: field, message: `This ${field} is already registered` },
      ]);
    }
    throw err;
  }
}

export const INVALID_CREDENTIALS = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email/mobile or password');

let dummyHash: Promise<string> | undefined;

/** Resolves credentials to a user id, or null. Does equal work for unknown users to blunt timing probes. */
export async function verifyCredentials(
  db: Queryable,
  hasher: PasswordHasher,
  input: LoginInput,
): Promise<string | null> {
  const id = input.identifier;
  let column: 'email' | 'mobile' | null = null;
  let value: string | null = null;
  if (id.includes('@')) {
    column = 'email';
    value = normalizeEmail(id);
  } else {
    value = normalizeMobile(id);
    column = value ? 'mobile' : null;
  }

  let user: { id: string; password_hash: string; status: string } | undefined;
  if (column && value) {
    const r = await db.query<{ id: string; password_hash: string; status: string }>(
      `SELECT id, password_hash, status FROM users WHERE ${column} = $1`,
      [value],
    );
    user = r.rows[0];
  }

  if (!user) {
    dummyHash ??= hasher.hash('not-a-real-password');
    await hasher.verify(await dummyHash, input.password);
    return null;
  }
  const ok = await hasher.verify(user.password_hash, input.password);
  if (!ok || user.status !== 'ACTIVE') return null;

  if (hasher.needsRehash(user.password_hash)) {
    const upgraded = await hasher.hash(input.password);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [upgraded, user.id]);
  }
  return user.id;
}
