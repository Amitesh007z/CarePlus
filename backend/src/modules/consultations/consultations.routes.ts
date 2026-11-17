import { Router } from 'express';
import { auditContext, pageMeta, pageQuery, parseUuid, send } from '../../common/http.js';
import type { Database } from '../../infrastructure/database/pool.js';
import { protect } from '../auth/auth.middleware.js';
import { getAppointmentForDoctor } from '../appointments/appointments.service.js';
import {
  addAddendum,
  consultationForAppointment,
  finalizeConsultation,
  getConsultationForDoctor,
  listPatientHistoryForDoctor,
  listVisitsForPatient,
  openConsultation,
  saveDraft,
} from './consultations.service.js';
import { addendumSchema, consultationDraftSchema } from './consultations.schemas.js';

export function consultationsRouter({ db, nodeEnv }: { db: Database; nodeEnv: string }): Router {
  const r = Router();
  const deps = { db, nodeEnv };
  const doctor = protect(deps, 'DOCTOR');
  const patient = protect(deps, 'PATIENT');

  // Doctor's view of one of their own appointments, with the consultation status if one is open.
  r.get('/doctor/appointments/:id', ...doctor, async (req, res) => {
    const id = parseUuid(req.params.id);
    const appointment = await getAppointmentForDoctor(db, req.auth!.userId, id);
    send(req, res, { appointment, consultation: await consultationForAppointment(db, id) });
  });

  r.post('/doctor/appointments/:id/consultation', ...doctor, async (req, res) => {
    const id = parseUuid(req.params.id);
    const { view, created } = await openConsultation(db, req.auth!.userId, id, auditContext(req));
    send(req, res, view, created ? 201 : 200);
  });

  r.get('/doctor/consultations/:id', ...doctor, async (req, res) => {
    send(req, res, await getConsultationForDoctor(db, req.auth!.userId, parseUuid(req.params.id)));
  });

  r.put('/doctor/consultations/:id', ...doctor, async (req, res) => {
    const id = parseUuid(req.params.id);
    const draft = consultationDraftSchema.parse(req.body);
    send(req, res, await saveDraft(db, req.auth!.userId, id, draft, auditContext(req)));
  });

  r.post('/doctor/consultations/:id/finalize', ...doctor, async (req, res) => {
    const id = parseUuid(req.params.id);
    send(req, res, await finalizeConsultation(db, req.auth!.userId, id, auditContext(req)));
  });

  r.post('/doctor/consultations/:id/addenda', ...doctor, async (req, res) => {
    const id = parseUuid(req.params.id);
    const { content } = addendumSchema.parse(req.body);
    send(req, res, await addAddendum(db, req.auth!.userId, id, content, auditContext(req)), 201);
  });

  r.get('/doctor/patients/:patientId/history', ...doctor, async (req, res) => {
    const patientId = parseUuid(req.params.patientId);
    const q = pageQuery.parse(req.query);
    const { items, total } = await listPatientHistoryForDoctor(db, req.auth!.userId, patientId, q);
    send(req, res, { items, meta: pageMeta(q, total) });
  });

  // Patients see only their own finalized visits. Drafts are never returned.
  r.get('/patients/me/visits', ...patient, async (req, res) => {
    const q = pageQuery.parse(req.query);
    const { items, total } = await listVisitsForPatient(db, req.auth!.userId, q);
    send(req, res, { items, meta: pageMeta(q, total) });
  });

  return r;
}
