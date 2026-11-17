import { Router } from 'express';
import { auditContext, parseUuid, send } from '../../common/http.js';
import type { Database } from '../../infrastructure/database/pool.js';
import { protect } from '../auth/auth.middleware.js';
import { syncStatus } from '../search/search-sync.js';
import type { SearchProvider } from '../search/search-provider.js';
import * as catalogue from './catalogue.service.js';
import {
  adminMedicineQuery,
  catalogueQuery,
  interactionCreateSchema,
  medicineCreateSchema,
  medicineUpdateSchema,
} from './catalogue.schemas.js';

/**
 * Public catalogue reads never include inactive medicines or exact stock counts. Writes are admin-only and
 * go through PostgreSQL first. Search is best-effort: the provider can be absent, slow or down without
 * affecting any write.
 */
export function catalogueRouter({ db, nodeEnv, search }: { db: Database; nodeEnv: string; search: SearchProvider | null }): Router {
  const r = Router();
  const admin = protect({ db, nodeEnv }, 'ADMIN');

  r.get('/catalogue/medicines', async (req, res) => {
    send(req, res, await catalogue.listCatalogue(db, catalogueQuery.parse(req.query)));
  });

  r.get('/catalogue/medicines/:id', async (req, res) => {
    send(req, res, await catalogue.getPublicMedicine(db, parseUuid(req.params.id)));
  });

  r.get('/catalogue/search', async (req, res) => {
    send(req, res, await catalogue.searchCatalogue(db, search, catalogueQuery.parse(req.query)));
  });

  r.get('/catalogue/categories', async (req, res) => {
    send(req, res, { items: await catalogue.listCategories(db) });
  });

  // ---- Admin -----------------------------------------------------------------------------------
  r.get('/admin/medicines', ...admin, async (req, res) => {
    send(req, res, await catalogue.listAdminMedicines(db, adminMedicineQuery.parse(req.query)));
  });

  r.post('/admin/medicines', ...admin, async (req, res) => {
    send(req, res, await catalogue.createMedicine(db, medicineCreateSchema.parse(req.body), auditContext(req)), 201);
  });

  r.get('/admin/medicines/:id', ...admin, async (req, res) => {
    send(req, res, await catalogue.getAdminMedicine(db, parseUuid(req.params.id)));
  });

  r.patch('/admin/medicines/:id', ...admin, async (req, res) => {
    send(req, res, await catalogue.updateMedicine(db, parseUuid(req.params.id), medicineUpdateSchema.parse(req.body), auditContext(req)));
  });

  r.post('/admin/medicines/:id/deactivate', ...admin, async (req, res) => {
    send(req, res, await catalogue.deactivateMedicine(db, parseUuid(req.params.id), auditContext(req)));
  });

  r.post('/admin/drug-interactions', ...admin, async (req, res) => {
    send(req, res, { items: await catalogue.createInteraction(db, interactionCreateSchema.parse(req.body), auditContext(req)) }, 201);
  });

  r.get('/admin/search/status', ...admin, async (req, res) => {
    send(req, res, { configured: search !== null, jobs: await syncStatus(db) });
  });

  return r;
}
