import { Router } from 'express';
import type { Queryable } from '../../infrastructure/database/pool.js';
import { protect } from '../auth/auth.middleware.js';
import type { Role } from '../auth/session.service.js';
import { loadUserView } from '../auth/user.repository.js';

const SHELLS: { path: string; role: Role }[] = [
  { path: '/patient/dashboard', role: 'PATIENT' },
  { path: '/doctor/dashboard', role: 'DOCTOR' },
  { path: '/pharmacy/dashboard', role: 'PHARMACIST' },
  { path: '/admin/dashboard', role: 'ADMIN' },
];

/**
 * Role-guarded dashboard shells. Each returns only the caller's own profile; feature data
 * (appointments, orders, stock) is attached by later checkpoints behind the same guards.
 */
export function dashboardsRouter(deps: { db: Queryable; nodeEnv: string }): Router {
  const router = Router();
  for (const { path, role } of SHELLS) {
    router.get(path, ...protect(deps, role), async (req, res) => {
      const profile = await loadUserView(deps.db, req.auth!.userId);
      res.json({ success: true, data: { role, profile }, requestId: req.id });
    });
  }
  return router;
}
