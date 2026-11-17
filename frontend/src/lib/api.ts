import { API_BASE_URL } from './env';

export interface ApiErrorDetail {
  path?: string;
  message: string;
}

/** Error shape returned by the API (and synthesized for network failures). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: ApiErrorDetail[] = [],
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface SuccessEnvelope<T> {
  success: true;
  data: T;
  requestId: string;
}

interface ErrorEnvelope {
  success: false;
  error: { code: string; message: string; details?: ApiErrorDetail[] };
  requestId?: string;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

// Held in memory only (never localStorage). Sent on state-changing requests; the server re-checks it.
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Typed JSON request. Resolves with `data`; rejects with ApiError. Cookies are sent for session auth. */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      credentials: 'include',
      signal: options.signal,
      headers: {
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        ...options.headers,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the server. Check your connection and try again.');
  }

  let payload: SuccessEnvelope<T> | ErrorEnvelope | undefined;
  try {
    payload = (await response.json()) as SuccessEnvelope<T> | ErrorEnvelope;
  } catch {
    payload = undefined;
  }

  if (!response.ok || !payload || payload.success !== true) {
    const err = payload && payload.success === false ? payload.error : undefined;
    throw new ApiError(
      response.status,
      err?.code ?? 'UNEXPECTED_RESPONSE',
      err?.message ?? 'The server returned an unexpected response.',
      err?.details ?? [],
      payload?.requestId,
    );
  }
  return payload.data;
}

export interface PingResult {
  message: string;
  time: string;
}

export const pingApi = (signal?: AbortSignal) => apiRequest<PingResult>('/api/v1/ping', { signal });
