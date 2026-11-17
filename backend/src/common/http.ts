import type { Request, Response } from 'express';
import { z } from 'zod';
import { notFound } from './errors/AppError.js';
import { istDateOf } from './time.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route params: an invalid id is reported as "not found" so probing reveals nothing. */
export function parseUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw notFound();
  return value;
}

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof pageQuery>;

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export const pageWindow = (q: PageQuery) => ({ limit: q.pageSize, offset: (q.page - 1) * q.pageSize });

export const pageMeta = (q: PageQuery, total: number): PageMeta => ({
  page: q.page,
  pageSize: q.pageSize,
  total,
  totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
});

/** A YYYY-MM-DD calendar date that really exists. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const calendarDate = z.string().refine(isCalendarDate, 'Use a valid date in the format YYYY-MM-DD');

/** A calendar date that is not in the future (in clinic time). */
export const pastOrTodayDate = calendarDate.refine((v) => v <= istDateOf(new Date()), 'Date cannot be in the future');

export function send(req: Request, res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data, requestId: req.id });
}

/** Actor and request context for audit rows. The actor is always the authenticated session, never client input. */
export const auditContext = (req: Request) => ({
  actorId: req.auth?.userId ?? null,
  requestId: typeof req.id === 'string' ? req.id : undefined,
});
