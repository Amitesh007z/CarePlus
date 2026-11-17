import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ApiError, pingApi } from '../../lib/api';

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; time: string }
  | { phase: 'error'; message: string; requestId?: string };

/** Connectivity check against GET /api/v1/ping. */
export function ApiStatusCard() {
  const [state, setState] = useState<State>({ phase: 'loading' });

  const check = useCallback((signal?: AbortSignal) => {
    setState({ phase: 'loading' });
    pingApi(signal)
      .then((r) => setState({ phase: 'ok', time: r.time }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState(
          err instanceof ApiError
            ? { phase: 'error', message: err.message, requestId: err.requestId }
            : { phase: 'error', message: 'Unexpected error.' },
        );
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    check(controller.signal);
    return () => controller.abort();
  }, [check]);

  return (
    <Card title="API connection" aria-live="polite">
      {state.phase === 'loading' && <p className="text-sm text-slate-600">Checking the API…</p>}
      {state.phase === 'ok' && (
        <p className="text-sm text-green-800">
          <span aria-hidden="true">● </span>Connected. Server time {new Date(state.time).toLocaleTimeString()}.
        </p>
      )}
      {state.phase === 'error' && (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-red-800">
            {state.message}
            {state.requestId && <span className="block text-xs text-slate-500">Reference: {state.requestId}</span>}
          </p>
          <Button variant="secondary" onClick={() => check()}>
            Retry
          </Button>
        </div>
      )}
    </Card>
  );
}
