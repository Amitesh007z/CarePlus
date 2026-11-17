import { Router } from 'express';
import { z } from 'zod';
import { calendarDate, pageMeta, pageQuery, parseUuid, send } from '../../common/http.js';
import { istDateOf } from '../../common/time.js';
import type { Database } from '../../infrastructure/database/pool.js';
import { protect } from '../auth/auth.middleware.js';
import * as doctors from './doctors.service.js';

const directoryQuery = pageQuery.extend({ query: z.string().trim().max(80).optional() });
const slotsQuery = z.object({
  from: calendarDate.optional(),
  days: z.coerce.number().int().min(1).max(14).default(7),
});

export function doctorsRouter({ db, nodeEnv }: { db: Database; nodeEnv: string }): Router {
  const r = Router();
  const deps = { db, nodeEnv };
  const patient = protect(deps, 'PATIENT');

  // Public directory fields only. Authenticated patients only, to limit scraping.
  r.get('/doctors', ...patient, async (req, res) => {
    const q = directoryQuery.parse(req.query);
    const { items, total } = await doctors.listDoctors(db, q);
    send(req, res, { items, meta: pageMeta(q, total) });
  });

  r.get('/doctors/:id', ...patient, async (req, res) => {
    send(req, res, await doctors.getDoctor(db, parseUuid(req.params.id)));
  });

  r.get('/doctors/:id/slots', ...patient, async (req, res) => {
    const id = parseUuid(req.params.id);
    const q = slotsQuery.parse(req.query);
    const from = q.from ?? istDateOf(new Date());
    const slots = await doctors.listOpenSlots(db, id, from, q.days);
    send(req, res, { timezone: 'Asia/Kolkata', from, days: q.days, slots });
  });

  // Doctor's view of one patient: allowed only with a live appointment and current consent.
  r.get('/doctor/patients/:patientId/context', ...protect(deps, 'DOCTOR'), async (req, res) => {
    const patientId = parseUuid(req.params.patientId);
    send(req, res, await doctors.getPatientContextForDoctor(db, req.auth!.userId, patientId));
  });

  return r;
}
