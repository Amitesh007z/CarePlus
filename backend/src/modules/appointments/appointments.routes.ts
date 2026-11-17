import { Router } from 'express';
import { auditContext, pageMeta, parseUuid, send } from '../../common/http.js';
import { addDays, istDateOf } from '../../common/time.js';
import type { Database } from '../../infrastructure/database/pool.js';
import { protect } from '../auth/auth.middleware.js';
import * as appts from './appointments.service.js';
import {
  bookSchema,
  cancelSchema,
  doctorListQuery,
  doctorStatusSchema,
  patientListQuery,
  rescheduleSchema,
} from './appointments.schemas.js';

export function appointmentsRouter({ db, nodeEnv }: { db: Database; nodeEnv: string }): Router {
  const r = Router();
  const deps = { db, nodeEnv };
  const patient = protect(deps, 'PATIENT');
  const doctor = protect(deps, 'DOCTOR');

  r.post('/appointments', ...patient, async (req, res) => {
    const input = bookSchema.parse(req.body);
    send(req, res, await appts.bookAppointment(db, req.auth!.userId, input, auditContext(req)), 201);
  });

  r.get('/appointments/me', ...patient, async (req, res) => {
    const q = patientListQuery.parse(req.query);
    const { items, total } = await appts.listPatientAppointments(db, req.auth!.userId, q.scope, q);
    send(req, res, { items, meta: pageMeta(q, total) });
  });

  r.post('/appointments/:id/cancel', ...patient, async (req, res) => {
    const id = parseUuid(req.params.id);
    const { reason } = cancelSchema.parse(req.body ?? {});
    send(req, res, await appts.cancelAppointment(db, req.auth!.userId, id, reason, auditContext(req)));
  });

  r.patch('/appointments/:id/reschedule', ...patient, async (req, res) => {
    const id = parseUuid(req.params.id);
    const { slotId } = rescheduleSchema.parse(req.body);
    send(req, res, await appts.rescheduleAppointment(db, req.auth!.userId, id, slotId, auditContext(req)));
  });

  r.get('/doctor/appointments', ...doctor, async (req, res) => {
    const today = istDateOf(new Date());
    const q = doctorListQuery.parse(req.query);
    const from = q.from ?? today;
    const to = q.to ?? addDays(from, 7);
    const { items, total } = await appts.listDoctorAppointments(db, req.auth!.userId, { ...q, from, to });
    send(req, res, { items, meta: pageMeta(q, total), window: { from, to, timezone: 'Asia/Kolkata' } });
  });

  r.patch('/doctor/appointments/:id/status', ...doctor, async (req, res) => {
    const id = parseUuid(req.params.id);
    const { status } = doctorStatusSchema.parse(req.body);
    send(req, res, await appts.setStatusByDoctor(db, req.auth!.userId, id, status, auditContext(req)));
  });

  return r;
}

