import pino, { type DestinationStream, type Logger } from 'pino';

/** Paths whose values are never written to logs. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.secret',
  '*.apiKey',
  'password',
  'token',
  'secret',
  'apiKey',
  'connectionString',
  'databaseUrl',
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    { level, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' }, base: { service: 'carepulse-api' } },
    destination,
  );
}
