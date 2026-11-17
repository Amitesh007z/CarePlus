import { Router } from 'express';
import { auditContext, pageMeta, parseUuid, send } from '../../common/http.js';
import { pageQuery } from '../../common/http.js';
import type { Database } from '../../infrastructure/database/pool.js';
import { protect } from '../auth/auth.middleware.js';
import { istDateOf } from '../../common/time.js';
import { renderPrescriptionPdf } from './prescription-pdf.js';
import * as rx from './prescriptions.service.js';
import { headerUpdateSchema, itemCreateSchema, itemUpdateSchema, medicineSearchQuery } from './prescriptions.schemas.js';
import { AppError } from '../../common/errors/AppError.js';

export function prescriptionsRouter({ db, nodeEnv }: { db: Database; nodeEnv: string }): Router {
  const r = Router();
  const deps = { db, nodeEnv };
  const doctor = protect(deps, 'DOCTOR');
  const patient = protect(deps, 'PATIENT');

  r.get('/medicines', ...doctor, async (req, res) => {
    const q = medicineSearchQuery.parse(req.query);
    const { items, total } = await rx.searchMedicines(db, q.query, q);
    send(req, res, { items, meta: pageMeta(q, total) });
  });

  r.post('/doctor/consultations/:id/prescriptions', ...doctor, async (req, res) => {
    const id = await rx.createDraft(db, req.auth!.userId, parseUuid(req.params.id), auditContext(req));
    send(req, res, await rx.getForDoctor(db, req.auth!.userId, id), 201);
  });

  r.get('/doctor/consultations/:id/prescriptions', ...doctor, async (req, res) => {
    send(req, res, { items: await rx.listForConsultation(db, req.auth!.userId, parseUuid(req.params.id)) });
  });

  r.get('/doctor/prescriptions/:id', ...doctor, async (req, res) => {
    send(req, res, await rx.getForDoctor(db, req.auth!.userId, parseUuid(req.params.id)));
  });

  r.patch('/doctor/prescriptions/:id', ...doctor, async (req, res) => {
    const id = parseUuid(req.params.id);
    const { advice } = headerUpdateSchema.parse(req.body);
    await rx.updateAdvice(db, req.auth!.userId, id, advice, auditContext(req));
    send(req, res, await rx.getForDoctor(db, req.auth!.userId, id));
  });

  r.post('/doctor/prescriptions/:id/items', ...doctor, async (req, res) => {
    const id = parseUuid(req.params.id);
    await rx.addItem(db, req.auth!.userId, id, itemCreateSchema.parse(req.body), auditContext(req));
    send(req, res, await rx.getForDoctor(db, req.auth!.userId, id), 201);
  });

  r.patch('/doctor/prescriptions/:id/items/:itemId', ...doctor, async (req, res) => {
    const id = parseUuid(req.params.id);
    await rx.updateItem(db, req.auth!.userId, id, parseUuid(req.params.itemId), itemUpdateSchema.parse(req.body), auditContext(req));
    send(req, res, await rx.getForDoctor(db, req.auth!.userId, id));
  });

  r.delete('/doctor/prescriptions/:id/items/:itemId', ...doctor, async (req, res) => {
    const id = parseUuid(req.params.id);
    await rx.removeItem(db, req.auth!.userId, id, parseUuid(req.params.itemId), auditContext(req));
    send(req, res, await rx.getForDoctor(db, req.auth!.userId, id));
  });

  r.post('/doctor/prescriptions/:id/issue', ...doctor, async (req, res) => {
    send(req, res, await rx.issuePrescription(db, req.auth!.userId, parseUuid(req.params.id), auditContext(req)));
  });

  r.post('/doctor/prescriptions/:id/replace', ...doctor, async (req, res) => {
    const newId = await rx.createReplacement(db, req.auth!.userId, parseUuid(req.params.id), auditContext(req));
    send(req, res, await rx.getForDoctor(db, req.auth!.userId, newId), 201);
  });

  r.get('/doctor/prescriptions/:id/pdf', ...doctor, async (req, res) => {
    const view = await rx.getForDoctor(db, req.auth!.userId, parseUuid(req.params.id));
    if (view.status === 'DRAFT' || !view.rxNumber) throw new AppError(409, 'NOT_ISSUED', 'Only issued prescriptions have a PDF');
    sendPdf(res, view.rxNumber, await renderPrescriptionPdf(view));
  });

  r.get('/patients/me/prescriptions', ...patient, async (req, res) => {
    const q = pageQuery.parse(req.query);
    const { items, total } = await rx.listForPatient(db, req.auth!.userId, q);
    send(req, res, { items, meta: pageMeta(q, total), today: istDateOf(new Date()) });
  });

  r.get('/patients/me/prescriptions/:id', ...patient, async (req, res) => {
    send(req, res, await rx.getForPatient(db, req.auth!.userId, parseUuid(req.params.id)));
  });

  r.get('/patients/me/prescriptions/:id/pdf', ...patient, async (req, res) => {
    const view = await rx.getForPatient(db, req.auth!.userId, parseUuid(req.params.id));
    if (!view.rxNumber) throw new AppError(409, 'NOT_ISSUED', 'Only issued prescriptions have a PDF');
    sendPdf(res, view.rxNumber, await renderPrescriptionPdf(view));
  });

  return r;
}

function sendPdf(res: import('express').Response, rxNumber: string, pdf: Buffer): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${rxNumber}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(pdf);
}
