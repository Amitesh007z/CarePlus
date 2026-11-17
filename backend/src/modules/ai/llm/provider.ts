import type { ZodType } from 'zod';

/**
 * Provider-neutral LLM port. Domain code depends only on this file, never on a vendor SDK.
 * Keys live in backend configuration; nothing here is ever sent to the browser.
 */
export interface LlmJsonRequest {
  system: string;
  /** Untrusted content (user text, document passages). The system prompt tells the model to treat it as data. */
  user: string;
  timeoutMs: number;
}

export interface LlmProvider {
  /** Stable identifier written to the AI interaction log, e.g. "gemini". */
  readonly name: string;
  readonly model: string;
  /** Returns the raw model text, expected to be one JSON object. Throws LlmError. */
  generateJson(req: LlmJsonRequest): Promise<string>;
  /** Embeddings for AI-B retrieval. Optional: only providers used for knowledge indexing implement it. */
  embed?(texts: string[], kind: 'query' | 'document', timeoutMs: number): Promise<number[][]>;
}

export type LlmErrorKind = 'TIMEOUT' | 'UNAVAILABLE';

/** Transport-level failure. The message never contains keys, prompts or response bodies. */
export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export type StructuredFailure = 'TIMEOUT' | 'UNAVAILABLE' | 'INVALID';

export type StructuredResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; reason: StructuredFailure; attempts: number };

/**
 * Validates model output against a strict schema. Invalid output gets exactly one retry (bounded);
 * timeouts and transport failures are not retried, so the caller can fall back without doubling latency.
 */
export async function callStructured<T>(
  provider: LlmProvider,
  opts: {
    system: string;
    user: string;
    timeoutMs: number;
    schema: ZodType<T>;
    /** Extra business checks beyond the schema. Return an error message to reject the output. */
    check?: (value: T) => string | null;
    maxAttempts?: number;
  },
): Promise<StructuredResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 2;
  let attempts = 0;
  let system = opts.system;
  while (attempts < maxAttempts) {
    attempts += 1;
    let raw: string;
    try {
      raw = await provider.generateJson({ system, user: opts.user, timeoutMs: opts.timeoutMs });
    } catch (err) {
      if (err instanceof LlmError && err.kind === 'TIMEOUT') return { ok: false, reason: 'TIMEOUT', attempts };
      return { ok: false, reason: 'UNAVAILABLE', attempts };
    }
    const value = parseAndValidate(raw, opts.schema, opts.check);
    if (value.ok) return { ok: true, value: value.value, attempts };
    // Retry with a stricter reminder. The rejected output is not echoed back into the prompt.
    system = `${opts.system}\n\nYour previous reply was rejected because it did not match the required JSON format or rules. Reply with only the JSON object, nothing else.`;
  }
  return { ok: false, reason: 'INVALID', attempts };
}

function parseAndValidate<T>(
  raw: string,
  schema: ZodType<T>,
  check?: (value: T) => string | null,
): { ok: true; value: T } | { ok: false } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false };
  if (check && check(parsed.data) !== null) return { ok: false };
  return { ok: true, value: parsed.data };
}
