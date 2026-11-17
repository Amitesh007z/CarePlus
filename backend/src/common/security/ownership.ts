import { notFound } from '../errors/AppError.js';
import type { AuthContext } from '../../modules/auth/session.service.js';

/**
 * Resource-level authorization foundation. Role checks say *what kind* of user may call an endpoint;
 * this says whether *this* user may touch *this* record. Foreign records are reported as 404 so that
 * their existence is not revealed (IDOR defence).
 */
export function assertOwner(actor: AuthContext, ownerUserId: string): void {
  if (actor.userId !== ownerUserId) throw notFound();
}
