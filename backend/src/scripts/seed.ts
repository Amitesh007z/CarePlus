import 'dotenv/config';
import { loadEnv } from '../config/env.js';
import { getDriver } from '../infrastructure/database/driver.js';
import { createPasswordHasher } from '../modules/auth/password.js';
import { upsertMedicineSeed } from '../modules/medicines/catalogue.seed.js';

/**
 * Synthetic demo accounts. Idempotent: existing users are left untouched (passwords are never reset).
 * Demo password is for local demos only; production refuses to seed without SEED_DEMO_PASSWORD.
 * The pharmacist has no default password: SEED_PHARMACIST_PASSWORD is required.
 */
const env = loadEnv();
const url = env.DIRECT_DATABASE_URL ?? env.DATABASE_URL;
const demoPassword = process.env.SEED_DEMO_PASSWORD ?? (env.NODE_ENV === 'production' ? undefined : 'Demo@1234');
const pharmacistPassword = process.env.SEED_PHARMACIST_PASSWORD;

if (!demoPassword) {
  console.error('Refusing to seed in production without SEED_DEMO_PASSWORD.');
  process.exit(1);
}

type Seed =
  | { role: 'PATIENT'; email: string; mobile: string; password: string; profile: Record<string, string> }
  | { role: 'DOCTOR'; email: string; mobile: string; password: string; profile: { displayName: string; specialty: string; registrationNo: string; experienceYears: number } }
  | { role: 'PHARMACIST' | 'ADMIN'; email: string; mobile: string; password: string; profile: { displayName: string } };

const seeds: Seed[] = [
  {
    role: 'PATIENT', email: 'anita.rao@example.com', mobile: '9876500001', password: demoPassword,
    profile: { fullName: 'Anita Rao', dob: '1991-04-12', gender: 'FEMALE', bloodGroup: 'B+', addressLine: '14 Lakeview Residency, Indiranagar', city: 'Bengaluru', state: 'Karnataka', pincode: '560038', ecName: 'Suresh Rao', ecPhone: '9876500101' },
  },
  {
    role: 'PATIENT', email: 'vikram.s@example.com', mobile: '9876500002', password: demoPassword,
    profile: { fullName: 'Vikram Singh', dob: '1985-09-30', gender: 'MALE', bloodGroup: 'O+', addressLine: '22 Park Street, Salt Lake', city: 'Kolkata', state: 'West Bengal', pincode: '700091', ecName: 'Meera Singh', ecPhone: '9876500102' },
  },
  {
    role: 'DOCTOR', email: 'dr.mehta@example.com', mobile: '9876500003', password: demoPassword,
    profile: { displayName: 'Dr. Mehta', specialty: 'General Physician', registrationNo: 'SYN-REG-0001', experienceYears: 12 },
  },
  { role: 'ADMIN', email: 'admin@example.com', mobile: '9876500004', password: demoPassword, profile: { displayName: 'CarePulse Admin' } },
];
if (pharmacistPassword) {
  seeds.push({ role: 'PHARMACIST', email: 'pharmacist@example.com', mobile: '9876500005', password: pharmacistPassword, profile: { displayName: 'CarePulse Pharmacy' } });
} else {
  console.warn('SEED_PHARMACIST_PASSWORD not set: skipping the pharmacist account.');
}

const hasher = createPasswordHasher();
const client = new (getDriver().Client)({ connectionString: url });
await client.connect();
try {
  const added = await upsertMedicineSeed(client);
  console.log(`medicines: ${added} added (existing SKUs untouched)`);
  for (const s of seeds) {
    const exists = await client.query('SELECT 1 FROM users WHERE email = $1', [s.email]);
    if (exists.rowCount) {
      console.log(`exists   ${s.role.padEnd(10)} ${s.email}`);
      continue;
    }
    const hash = await hasher.hash(s.password);
    await client.query('BEGIN');
    try {
      const u = await client.query<{ id: string }>(
        'INSERT INTO users (role, email, mobile, password_hash, email_verified_at) VALUES ($1,$2,$3,$4,now()) RETURNING id',
        [s.role, s.email, s.mobile, hash],
      );
      const id = u.rows[0]!.id;
      if (s.role === 'PATIENT') {
        const p = s.profile;
        await client.query(
          `INSERT INTO patient_profiles (user_id, full_name, dob, gender, blood_group, address_line, city, state, pincode,
             emergency_contact_name, emergency_contact_phone, consent_status, consent_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,now())`,
          [id, p.fullName, p.dob, p.gender, p.bloodGroup, p.addressLine, p.city, p.state, p.pincode, p.ecName, p.ecPhone],
        );
      } else if (s.role === 'DOCTOR') {
        const p = s.profile;
        await client.query(
          'INSERT INTO doctor_profiles (user_id, display_name, specialty, registration_no, experience_years) VALUES ($1,$2,$3,$4,$5)',
          [id, p.displayName, p.specialty, p.registrationNo, p.experienceYears],
        );
      } else {
        const table = s.role === 'PHARMACIST' ? 'pharmacist_profiles' : 'admin_profiles';
        await client.query(`INSERT INTO ${table} (user_id, display_name) VALUES ($1,$2)`, [id, s.profile.displayName]);
      }
      await client.query('COMMIT');
      console.log(`created  ${s.role.padEnd(10)} ${s.email}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
} finally {
  await client.end();
}
