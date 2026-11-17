import { z } from 'zod';

const originList = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    const origins: string[] = [];
    for (const raw of value.split(',').map((s) => s.trim()).filter(Boolean)) {
      try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
        origins.push(url.origin);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be a comma-separated list of http(s) origins' });
        return z.NEVER;
      }
    }
    if (origins.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'at least one origin is required' });
      return z.NEVER;
    }
    return origins;
  });

const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => /^postgres(ql)?:\/\//.test(v), { message: 'must be a postgres:// or postgresql:// URL' });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_ORIGIN: originList,
  DATABASE_URL: postgresUrl,
  DIRECT_DATABASE_URL: z.preprocess((v) => (v === '' ? undefined : v), postgresUrl.optional()),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(8),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof schema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: { variable: string; message: string }[]) {
    super(
      `Invalid environment configuration:\n${issues.map((i) => `  - ${i.variable}: ${i.message}`).join('\n')}`,
    );
    this.name = 'EnvValidationError';
  }
}

/** Validates configuration. Error messages name variables only, never their values. */
export function loadEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new EnvValidationError(
      parsed.error.issues.map((i) => ({ variable: String(i.path[0] ?? 'unknown'), message: i.message })),
    );
  }
  return parsed.data;
}
