import { Router } from 'express';
import { z } from 'zod';
import { auditContext, pageQuery, parseUuid, send } from '../../common/http.js';
import type { Database } from '../../infrastructure/database/pool.js';
import { protect } from '../auth/auth.middleware.js';
import * as pharmacy from './pharmacy.service.js';
import { pharmacyDashboard } from './dashboard.service.js';
import { prescriptionReview } from './prescription-review.service.js';

const queueQuery = pageQuery.extend({ view: z.enum(['queue', 'active', 'done']).default('queue') });
const actionBody = z
  .object({
    action: z.enum(['verify', 'pack', 'dispatch', 'deliver', 'reject']),
    reason: z.string().trim().min(3, 'Give a reason for rejecting').max(300).optional(),
  })
  .strict()
  .refine((v) => v.action !== 'reject' || v.reason !== undefined, { message: 'Give a reason for rejecting', path: ['reason'] });
const stockQuery = pageQuery.extend({ q: z.string().trim().max(80).optional(), lowOnly: z.enum(['true', 'false']).optional() });
const stockBody = z
  .object({
    delta: z.number().int('Use a whole number').min(-10000).max(10000).refine((v) => v !== 0, 'Adjustment cannot be zero'),
    note: z.string().trim().min(3, 'Say why the stock changed').max(200),
  })
  .strict();

export function pharmacyRouter({ db, nodeEnv }: { db: Database; nodeEnv: string }): Router {
  const r = Router();
  const deps = { db, nodeEnv };
  const patient = protect(deps, 'PATIENT');
  const pharmacist = protect(deps, 'PHARMACIST');

  // ---- Patient: send an issued prescription to a pharmacy ---------------------------------------
  r.post('/patients/me/prescriptions/:id/fulfilment', ...patient, async (req, res) => {
    const id = await pharmacy.sendToPharmacy(db, req.auth!.userId, parseUuid(req.params.id), auditContext(req));
    send(req, res, { id, status: 'QUEUED' }, 201);
  });

  r.get('/patients/me/prescriptions/:id/fulfilment', ...patient, async (req, res) => {
    send(req, res, { fulfilment: await pharmacy.patientFulfilment(db, req.auth!.userId, parseUuid(req.params.id)) });
  });

  // ---- Pharmacist: queue, fulfilment, stock ------------------------------------------------------
  r.get('/pharmacy/fulfilments', ...pharmacist, async (req, res) => {
    const q = queueQuery.parse(req.query);
    send(req, res, await pharmacy.listFulfilments(db, q.view, q));
  });

  r.get('/pharmacy/fulfilments/:id', ...pharmacist, async (req, res) => {
    send(req, res, await pharmacy.getFulfilment(db, parseUuid(req.params.id)));
  });

  r.post('/pharmacy/fulfilments/:id/actions', ...pharmacist, async (req, res) => {
    const id = parseUuid(req.params.id);
    const body = actionBody.parse(req.body);
    await pharmacy.transition(db, req.auth!.userId, id, body.action, body.reason ?? null, auditContext(req));
    send(req, res, await pharmacy.getFulfilment(db, id));
  });

  r.get('/pharmacy/stock', ...pharmacist, async (req, res) => {
    const q = stockQuery.parse(req.query);
    send(req, res, await pharmacy.listStock(db, { ...q, lowOnly: q.lowOnly === 'true' }));
  });

  r.post('/pharmacy/medicines/:id/stock', ...pharmacist, async (req, res) => {
    const body = stockBody.parse(req.body);
    send(req, res, await pharmacy.adjustStock(db, req.auth!.userId, parseUuid(req.params.id), body.delta, body.note, auditContext(req)));
  });

  // The pharmacist's counts for the home screen. No patient data.
  r.get('/pharmacy/dashboard/summary', ...pharmacist, async (req, res) => {
    send(req, res, await pharmacyDashboard(db));
  });

  // Prescription review: only for prescriptions linked to pharmacy work. Read-only; never diagnosis or notes.
  r.get('/pharmacy/prescriptions/:rxId', ...pharmacist, async (req, res) => {
    send(req, res, await prescriptionReview(db, parseUuid(req.params.rxId)));
  });

  r.get('/pharmacy/medicines/:id/movements', ...pharmacist, async (req, res) => {
    send(req, res, { items: await pharmacy.listMovements(db, parseUuid(req.params.id)) });
  });

  return r;
}
