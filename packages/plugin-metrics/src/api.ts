// Métricas pela API do core (ADR 0125, 0135): o `catalog()` e o `query` do serviço em
// `/api/plugins/metrics/catalog` e `/api/plugins/metrics/query`, com `metrics.read`. As rotas são
// do plugin, dono do serviço: sem ele carregado, o core responde 404 explicando.

import { ApiError, type PluginHttpRoutes } from '@usebridger/core';
import { z } from '@usebridger/core/zod';
import type { MetricsService, QueryRow } from '#types.ts';

const labels = z.record(z.string(), z.string());
const base = { period: z.string(), labels };

const row = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('counter'), ...base, value: z.number() }),
    z.object({
      type: z.literal('histogram'),
      ...base,
      count: z.number(),
      sum: z.number(),
      // JSON não tem `Infinity`: o último balde sai como `'+Inf'`, como no Prometheus.
      buckets: z.array(
        z.object({ le: z.union([z.number(), z.literal('+Inf')]), count: z.number() }),
      ),
      p50: z.number(),
      p95: z.number(),
      p99: z.number(),
    }),
    z.object({ type: z.literal('gauge'), ...base, last: z.number(), max: z.number() }),
  ])
  .meta({ id: 'MetricQueryRow' });

const descriptor = z
  .object({
    name: z.string(),
    type: z.enum(['counter', 'histogram', 'gauge']),
    help: z.string(),
    labelNames: z.array(z.string()),
    buckets: z.array(z.number()).optional(),
    owner: z.string().optional(),
    live: z.boolean(),
  })
  .meta({ id: 'MetricDescriptor' });

/** Valor único ou repetido na query string, sempre como lista. */
const many = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value : [value]));

const query = z.object({
  name: z.string().min(1),
  from: z.string().min(1).meta({ description: '`YYYY-MM-DD`, ou `YYYY-MM-DDTHH` na hora' }),
  to: z.string().min(1),
  granularity: z.enum(['hour', 'day']).default('day'),
  where: many
    .optional()
    .meta({ description: 'Rótulo igual, `rótulo:valor`; repita para mais de um' })
    .transform((pairs, ctx) => {
      if (pairs === undefined) return undefined;
      const out: Record<string, string> = {};
      for (const pair of pairs) {
        const at = pair.indexOf(':');
        if (at <= 0) {
          ctx.addIssue({ code: 'custom', message: `"${pair}" fora do formato rótulo:valor` });
          return z.NEVER;
        }
        out[pair.slice(0, at)] = pair.slice(at + 1);
      }
      return out;
    }),
  groupBy: z
    .string()
    .optional()
    .meta({ description: 'Rótulos separados por vírgula; vazio (`groupBy=`) soma tudo' })
    .transform((value) => (value === undefined ? undefined : value.split(',').filter(Boolean))),
});

/** A linha do `query` como sai no JSON: o balde `Infinity` vira `'+Inf'`. */
function toJsonRow(r: QueryRow): z.input<typeof row> {
  if (r.type !== 'histogram') return r;
  return {
    ...r,
    buckets: r.buckets.map((b) => ({
      le: b.le === Number.POSITIVE_INFINITY ? '+Inf' : b.le,
      count: b.count,
    })),
  };
}

/** Registra as rotas; lança `BotConfigError` sem `BotConfig.http`, como o `ctx.http.route`. */
export function registerMetricsApi(
  http: PluginHttpRoutes,
  service: Pick<MetricsService, 'query' | 'catalog'>,
): void {
  http.api({
    method: 'GET',
    path: '/catalog',
    summary: 'Métricas conhecidas: declaradas no processo e só no histórico',
    tags: ['metrics'],
    permission: 'metrics.read',
    response: z.object({ metrics: z.array(descriptor) }),
    handler: async () => ({ metrics: await service.catalog() }),
  });
  http.api({
    method: 'GET',
    path: '/query',
    summary: 'Histórico de uma métrica por hora ou dia, com o período corrente',
    tags: ['metrics'],
    permission: 'metrics.read',
    query,
    response: z.object({ rows: z.array(row) }),
    handler: async ({ query: q }) => {
      const { where, groupBy, ...rest } = q;
      let rows: QueryRow[];
      try {
        rows = await service.query({
          ...rest,
          ...(where !== undefined && { where }),
          ...(groupBy !== undefined && { groupBy }),
        });
      } catch (error) {
        // O serviço lança `TypeError` para intervalo inválido ou fora da retenção: é do cliente.
        if (error instanceof TypeError) throw new ApiError(400, error.message);
        throw error;
      }
      return { rows: rows.map(toJsonRow) };
    },
  });
}
