import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import { AppError, notFound } from './AppError.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound('Route not found'));

interface HttpLikeError {
  type?: string;
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  // Express identifies error middleware by its 4-argument arity.
  return (err, req, res, _next) => {
    let status = 500;
    let expected = false;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: { path?: string; message: string }[] = [];

    if (err instanceof AppError) {
      ({ status, code, message, details } = err);
      expected = true;
    } else if (err instanceof ZodError) {
      status = 422;
      code = 'VALIDATION_ERROR';
      message = 'The request contains invalid fields';
      details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    } else {
      const e = err as HttpLikeError;
      if (e?.type === 'entity.too.large') {
        status = 413;
        code = 'PAYLOAD_TOO_LARGE';
        message = 'Request body is too large';
      } else if (e?.type === 'entity.parse.failed') {
        status = 400;
        code = 'INVALID_JSON';
        message = 'Request body is not valid JSON';
      }
    }

    if (status >= 500 && !expected) {
      // The full error is logged server-side only; the client gets a generic message.
      logger.error({ err, requestId: req.id }, 'unhandled error');
    } else if (status >= 500) {
      logger.warn({ code, requestId: req.id }, 'request failed');
    }

    res.status(status).json({ success: false, error: { code, message, details }, requestId: req.id });
  };
}
