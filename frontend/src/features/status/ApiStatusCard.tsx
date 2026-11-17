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
    <Card title="Service status" description="Live connection to the CarePulse API.">
      {state.phase === 'loading' && <p className="text-sm text-slate-500">Checking the API…</p>}
      {state.phase === 'ok' && (
        <p className="flex items-center gap-2 text-sm font-medium text-emerald-700">
          <span aria-hidden="true" className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
          </span>
          Connected. Server time {new Date(state.time).toLocaleTimeString()}.
        </p>
      )}
      {state.phase === 'error' && (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-rose-700">
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
