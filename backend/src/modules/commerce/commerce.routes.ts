import { Router } from 'express';
import { auditContext, pageQuery, parseUuid, send } from '../../common/http.js';
import { AppError } from '../../common/errors/AppError.js';
import type { Database } from '../../infrastructure/database/pool.js';
import { protect } from '../auth/auth.middleware.js';
import * as cart from './cart.service.js';
import * as orders from './orders.service.js';
import type { Mailer } from './notifications.js';
import {
  addressCreateSchema,
  cartItemAddSchema,
  cartItemPatchSchema,
  IDEMPOTENCY_KEY,
  orderCancelSchema,
  orderCreateSchema,
  pharmacyOrderActionSchema,
} from './commerce.schemas.js';
import { listAddresses, createAddress } from './addresses.service.js';
import { z } from 'zod';

const orderQueueQuery = pageQuery.extend({ view: z.enum(['queue', 'active', 'done']).default('queue') });

/** Patient checkout and pharmacist order work. Every route is role-gated; ownership is checked in the services. */
export function commerceRouter({ db, nodeEnv, mailer }: { db: Database; nodeEnv: string; mailer: Mailer | null }): Router {
  const r = Router();
  const deps = { db, nodeEnv };
  const patient = protect(deps, 'PATIENT');
  const pharmacist = protect(deps, 'PHARMACIST');
  const ctxOf = (req: Parameters<typeof auditContext>[0]) => auditContext(req);

  // ---- Addresses -------------------------------------------------------------------------------
  r.get('/patients/me/addresses', ...patient, async (req, res) => {
    send(req, res, { items: await listAddresses(db, req.auth!.userId) });
  });
  r.post('/patients/me/addresses', ...patient, async (req, res) => {
    send(req, res, await createAddress(db, req.auth!.userId, addressCreateSchema.parse(req.body), ctxOf(req)), 201);
  });

  // ---- Cart ------------------------------------------------------------------------------------
  r.get('/patients/me/cart', ...patient, async (req, res) => {
    send(req, res, await cart.buildCart(db, req.auth!.userId));
  });
  r.post('/patients/me/cart/items', ...patient, async (req, res) => {
    const body = cartItemAddSchema.parse(req.body);
    send(req, res, await cart.addCatalogueItem(db, req.auth!.userId, body.medicineId, body.quantity), 201);
  });
  r.patch('/patients/me/cart/items/:itemId', ...patient, async (req, res) => {
    const body = cartItemPatchSchema.parse(req.body);
    send(req, res, await cart.updateQuantity(db, req.auth!.userId, parseUuid(req.params.itemId), body.quantity));
  });
  r.delete('/patients/me/cart/items/:itemId', ...patient, async (req, res) => {
    send(req, res, await cart.removeItem(db, req.auth!.userId, parseUuid(req.params.itemId)));
  });
  r.post('/patients/me/cart/prescriptions/:rxId', ...patient, async (req, res) => {
    send(req, res, await cart.addFromPrescription(db, req.auth!.userId, parseUuid(req.params.rxId)), 201);
  });
  r.delete('/patients/me/cart/prescriptions/:rxId', ...patient, async (req, res) => {
    send(req, res, await cart.removePrescription(db, req.auth!.userId, parseUuid(req.params.rxId)));
  });
  r.delete('/patients/me/cart', ...patient, async (req, res) => {
    send(req, res, await cart.clearCart(db, req.auth!.userId));
  });

  // ---- Orders (patient) ------------------------------------------------------------------------
  r.post('/patients/me/orders', ...patient, async (req, res) => {
    const key = req.get('Idempotency-Key') ?? '';
    if (!IDEMPOTENCY_KEY.test(key)) {
      throw new AppError(422, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-64 letters, digits, - or _)');
    }
    const input = orderCreateSchema.parse(req.body);
    const placed = await orders.placeOrder(db, req.auth!.userId, key, input, ctxOf(req), mailer);
    const view = await orders.orderDetail(db, placed.orderId, 'PATIENT', req.auth!.userId);
    send(req, res, { ...view, replayed: placed.replayed }, placed.replayed ? 200 : 201);
  });

  r.get('/patients/me/orders', ...patient, async (req, res) => {
    send(req, res, await orders.listPatientOrders(db, req.auth!.userId, pageQuery.parse(req.query)));
  });

  r.get('/patients/me/orders/:id', ...patient, async (req, res) => {
    send(req, res, await orders.orderDetail(db, parseUuid(req.params.id), 'PATIENT', req.auth!.userId));
  });

  r.post('/patients/me/orders/:id/cancel', ...patient, async (req, res) => {
    const body = orderCancelSchema.parse(req.body ?? {});
    send(req, res, await orders.transitionOrder(db, { role: 'PATIENT', userId: req.auth!.userId }, parseUuid(req.params.id), 'cancel', body.reason ?? null, ctxOf(req)));
  });

  // ---- Orders (pharmacist) ---------------------------------------------------------------------
  r.get('/pharmacy/orders', ...pharmacist, async (req, res) => {
    const q = orderQueueQuery.parse(req.query);
    send(req, res, await orders.listPharmacyOrders(db, q.view, q));
  });

  r.get('/pharmacy/orders/:id', ...pharmacist, async (req, res) => {
    send(req, res, await orders.orderDetail(db, parseUuid(req.params.id), 'PHARMACIST'));
  });

  r.post('/pharmacy/orders/:id/actions', ...pharmacist, async (req, res) => {
    const body = pharmacyOrderActionSchema.parse(req.body);
    send(req, res, await orders.transitionOrder(db, { role: 'PHARMACIST', userId: req.auth!.userId }, parseUuid(req.params.id), body.action, body.reason ?? null, ctxOf(req)));
  });

  return r;
}
