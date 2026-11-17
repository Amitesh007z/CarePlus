import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from './api';

interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.';
}

/** GET helper with loading, error and retry. Pass `null` to skip the request. */
export function useApi<T>(path: string | null) {
  const [state, setState] = useState<ApiState<T>>({ data: null, error: null, loading: path !== null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    apiRequest<T>(path, { signal: controller.signal })
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState({ data: null, error: messageOf(err), loading: false });
      });
    return () => controller.abort();
  }, [path, attempt]);

  const reload = useCallback(() => setAttempt((a) => a + 1), []);
  return { ...state, reload };
}
