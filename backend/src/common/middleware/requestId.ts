import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

// `req.id` is typed by pino-http's IncomingMessage augmentation.
const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};
