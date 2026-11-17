import type { Queryable } from '../infrastructure/database/pool.js';

export interface AuditContext {
  actorId: string | null;
  requestId?: string;
}

/**
 * One row per sensitive change. Store identifiers and states only, never health text,
 * contact details or secrets, because the log is retained longer than the record.
 */
export interface AuditEvent {
  action: string;
  entityType: string;
  entityId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export async function audit(db: Queryable, ctx: AuditContext, event: AuditEvent): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, before_json, after_json, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      ctx.actorId,
      event.action,
      event.entityType,
      event.entityId,
      event.before ? JSON.stringify(event.before) : null,
      event.after ? JSON.stringify(event.after) : null,
      ctx.requestId ?? null,
    ],
  );
}
