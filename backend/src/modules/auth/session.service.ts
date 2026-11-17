import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../../infrastructure/database/pool.js';

export type Role = 'PATIENT' | 'DOCTOR' | 'PHARMACIST' | 'ADMIN';

export interface AuthContext {
  sessionId: string;
  userId: string;
  role: Role;
  csrfToken: string;
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface CreatedSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function createSession(db: Queryable, userId: string, ttlHours: number): Promise<CreatedSession> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const r = await db.query<{ expires_at: Date }>(
    `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4)) RETURNING expires_at`,
    [hashToken(token), userId, csrfToken, ttlHours],
  );
  return { token, csrfToken, expiresAt: r.rows[0]!.expires_at };
}

/** Returns the session only if it is unrevoked, unexpired, and its user is ACTIVE. */
export async function resolveSession(db: Queryable, token: string): Promise<AuthContext | null> {
  const r = await db.query<{ id: string; user_id: string; csrf_token: string; role: Role }>(
    `SELECT s.id, s.user_id, s.csrf_token, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'ACTIVE'`,
    [hashToken(token)],
  );
  const row = r.rows[0];
  return row ? { sessionId: row.id, userId: row.user_id, role: row.role, csrfToken: row.csrf_token } : null;
}

export async function revokeSessionByToken(db: Queryable, token: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [hashToken(token)]);
}

export async function revokeSessionById(db: Queryable, sessionId: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}
