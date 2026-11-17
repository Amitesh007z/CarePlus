import { Router } from 'express';
import { auditContext, pageMeta, parseUuid, pageQuery, send } from '../../common/http.js';
import type { Database } from '../../infrastructure/database/pool.js';
import { protect } from '../auth/auth.middleware.js';
import { loadUserView } from '../auth/user.repository.js';
import * as service from './patients.service.js';
import {
  consentSchema,
  healthCreateSchema,
  healthListQuery,
  healthUpdateSchema,
  medicationCreateSchema,
  medicationStopSchema,
  profileUpdateSchema,
} from './patients.schemas.js';

export function patientsRouter({ db, nodeEnv }: { db: Database; nodeEnv: string }): Router {
  const r = Router();
  const deps = { db, nodeEnv };
  const patient = protect(deps, 'PATIENT');

  r.get('/patients/me', ...patient, async (req, res) => {
    const user = await loadUserView(db, req.auth!.userId);
    send(req, res, { profile: user?.patient ?? null, email: user?.email ?? null, mobile: user?.mobile ?? null });
  });

  r.put('/patients/me', ...patient, async (req, res) => {
    await service.updateProfile(db, req.auth!.userId, profileUpdateSchema.parse(req.body), auditContext(req));
    const user = await loadUserView(db, req.auth!.userId);
    send(req, res, { profile: user?.patient ?? null });
  });

  r.post('/patients/me/consent', ...patient, async (req, res) => {
    const { granted } = consentSchema.parse(req.body);
    send(req, res, await service.setConsent(db, req.auth!.userId, granted, auditContext(req)));
  });

  r.get('/patients/me/health-info', ...patient, async (req, res) => {
    const q = healthListQuery.parse(req.query);
    const { items, total } = await service.listHealth(db, req.auth!.userId, q);
    send(req, res, { items, meta: pageMeta(q, total) });
  });

  r.post('/patients/me/health-info', ...patient, async (req, res) => {
    const item = await service.addHealthItem(db, req.auth!.userId, healthCreateSchema.parse(req.body), auditContext(req));
    send(req, res, item, 201);
  });

  r.patch('/patients/me/health-info/:id', ...patient, async (req, res) => {
    const id = parseUuid(req.params.id);
    const item = await service.updateHealthItem(db, req.auth!.userId, id, healthUpdateSchema.parse(req.body), auditContext(req));
    send(req, res, item);
  });

  r.get('/patients/me/medications', ...patient, async (req, res) => {
    const q = pageQuery.parse(req.query);
    const { items, total } = await service.listMedications(db, req.auth!.userId, q);
    send(req, res, { items, meta: pageMeta(q, total) });
  });

  r.post('/patients/me/medications', ...patient, async (req, res) => {
    const item = await service.addMedication(db, req.auth!.userId, medicationCreateSchema.parse(req.body), auditContext(req));
    send(req, res, item, 201);
  });

  r.patch('/patients/me/medications/:id', ...patient, async (req, res) => {
    const id = parseUuid(req.params.id);
    medicationStopSchema.parse(req.body);
    send(req, res, await service.stopMedication(db, req.auth!.userId, id, auditContext(req)));
  });

  return r;
}
