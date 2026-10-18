import type { HttpHandler, Logger, ServiceAccess } from '@usebridger/core';
// Só tipos: o `plugin-metrics` é dependência opcional (ADR 0107) e nada dele é carregado em runtime.
// O import também traz o `declare module` que tipa `services.get('metrics')`.
import type { MetricRow } from '@usebridger/plugin-metrics';

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const DAY_MS = 86_400_000;

export interface MetricsView {
  from: string;
  to: string;
  /** Uma entrada por métrica registrada, qualquer que seja o plugin dono. */
  metrics: { name: string; rows: MetricRow[] }[];
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * `GET /api/metrics?days=N` (1 a 90, padrão 7). Lista as métricas pelo `names` do serviço, para que
 * a registrada por qualquer plugin apareça sem mudar o dashboard. Sem o serviço: `{ available: false }`.
 */
export function registerMetricsRoutes(
  http: { route(method: 'GET', path: string, handler: HttpHandler): void },
  services: ServiceAccess,
  log: Logger,
  guarded: (handler: HttpHandler) => HttpHandler,
  now: () => number = Date.now,
): void {
  http.route(
    'GET',
    '/api/metrics',
    guarded(async (request) => {
      const raw = new URL(request.url).searchParams.get('days');
      const days = raw === null ? DEFAULT_DAYS : Number(raw);
      if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
        return new Response(`days precisa ser inteiro de 1 a ${MAX_DAYS}`, { status: 400 });
      }
      // Consulta a cada pedido: o plugin de métricas pode subir, cair ou recarregar depois do dashboard.
      if (!services.has('metrics')) return Response.json({ available: false });
      const range = { from: dayOf(now() - (days - 1) * DAY_MS), to: dayOf(now()) };
      try {
        const service = services.get('metrics');
        const names = await service.names(range);
        const metrics = await Promise.all(
          names.map(async (name) => ({ name, rows: await service.query(name, range) })),
        );
        const view: MetricsView = { ...range, metrics };
        return Response.json({ available: true, ...view });
      } catch (error) {
        log.error('dashboard: falha ao ler as métricas', { error });
        return new Response('erro interno', { status: 500 });
      }
    }),
  );
}
