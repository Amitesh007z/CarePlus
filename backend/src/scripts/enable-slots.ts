import 'dotenv/config';
import { createLogger } from '../common/logger.js';
import { istDateOf } from '../common/time.js';
import { loadEnv } from '../config/env.js';
import { createDatabase } from '../infrastructure/database/pool.js';
import { listOpenSlots } from '../modules/doctors/doctors.service.js';

/**
 * Demo helper: gives every active doctor weekly hours (Mon-Sun, 09:00-17:00, 30-minute slots) where none exist,
 * then materialises the next 14 days of bookable slots. Idempotent.
 */
const env = loadEnv();
const db = createDatabase({ connectionString: env.DIRECT_DATABASE_URL ?? env.DATABASE_URL, max: 2, logger: createLogger('silent') });
try {
  const doctors = (await db.query<{ id: string }>(
    `SELECT d.user_id AS id FROM doctor_profiles d JOIN users u ON u.id = d.user_id WHERE d.active AND u.status = 'ACTIVE'`,
  )).rows;
  let rules = 0;
  for (const d of doctors) {
    const r = await db.query(
      `INSERT INTO doctor_availability (doctor_user_id, weekday, start_time, end_time, slot_minutes)
       SELECT $1, w, '09:00', '17:00', 30 FROM generate_series(0, 6) AS w
        WHERE NOT EXISTS (SELECT 1 FROM doctor_availability WHERE doctor_user_id = $1 AND weekday = w)`,
      [d.id],
    );
    rules += r.rowCount ?? 0;
  }
  const from = istDateOf(new Date());
  let slots = 0;
  for (const d of doctors) slots += (await listOpenSlots(db, d.id, from, 14)).length;
  console.log(`doctors: ${doctors.length}; weekly rules added: ${rules}; open slots over the next 14 days: ${slots}`);
} finally {
  await db.close();
}
