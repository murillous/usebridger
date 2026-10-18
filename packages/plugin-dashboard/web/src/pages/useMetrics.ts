import { useEffect, useState } from 'react';
import { api } from '#web/lib/api.ts';
import type { MetricsResponse } from '#web/lib/types.ts';

/** Métricas dos últimos `days` dias; `error` quando a chamada falha (o resto da tela segue). */
export function useMetrics(days: number): { data?: MetricsResponse; error?: boolean } {
  const [state, setState] = useState<{ data?: MetricsResponse; error?: boolean }>({});
  useEffect(() => {
    let alive = true;
    setState({});
    api<MetricsResponse>(`metrics?days=${days}`).then(
      (data) => alive && setState({ data }),
      () => alive && setState({ error: true }),
    );
    return () => {
      alive = false;
    };
  }, [days]);
  return state;
}
