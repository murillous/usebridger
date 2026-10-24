import type { HttpHandler, Logger, ServiceAccess } from '@usebridger/core';
// Só tipos: o `plugin-metrics` é dependência opcional (ADR 0103) e nada dele é carregado em runtime.
// O import também traz o `declare module` que tipa `services.get('metrics')`.
import type { MetricRow } from '@usebridger/plugin-metrics';
import * as LOG from './log-events.ts';

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const DAY_MS = 86_400_000;

export interface MetricsView {
  from: string;
  to: string;
  /** Uma entrada por métrica registrada, qualquer que seja o plugin dono. */
  metrics: { name: string; rows: MetricRow[]; plugin?: string }[];
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
      // Lê o serviço a cada pedido, sem `optionalDependsOn`: assim o reload do metrics não reinicia o
      // dashboard em cascata e o plugin pode subir, cair ou voltar depois dele.
      if (!services.has('metrics')) return Response.json({ available: false });
      const range = { from: dayOf(now() - (days - 1) * DAY_MS), to: dayOf(now()) };
      try {
        const service = services.get('metrics');
        // Plugin-metrics anterior ao `names`: resposta explícita em vez de 500.
        if (typeof service.names !== 'function') {
          return Response.json({ available: false, reason: 'version' });
        }
        const names = await service.names(range);
        const metrics = await Promise.all(
          names.map(async (name) => {
            // Plugin-metrics sem `ownerOf` (anterior ao dono): a coluna mostra "-".
            const plugin = service.ownerOf?.(name);
            return {
              name,
              rows: await service.query(name, range),
              ...(plugin === undefined ? {} : { plugin }),
            };
          }),
        );
        const view: MetricsView = { ...range, metrics };
        return Response.json({ available: true, ...view });
      } catch (error) {
        log.event(LOG.metricsReadFailed, { err: error });
        return new Response('erro interno', { status: 500 });
      }
    }),
  );
}
