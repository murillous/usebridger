import { definePlugin, type PluginDefinition } from '@usebridger/core';
import { z } from '@usebridger/core/zod';
import { createMetrics, type MetricDoc, type MetricsRuntime } from '#service.ts';

export {
  type CounterRow,
  HISTOGRAM_BUCKETS,
  type HistogramRow,
  type MetricLabels,
  type MetricRow,
  type MetricsExporter,
  type MetricsRange,
  type MetricsService,
  type MetricsSnapshot,
} from '#types.ts';

// Um runtime por contexto: o mesmo objeto de plugin serve a vários bots e a reloads.
const runtimes = new WeakMap<object, { runtime: MetricsRuntime; timer: NodeJS.Timeout }>();

/** Plugin oficial `metrics` (ADR 0107): provê o serviço `metrics`. */
export const metrics: PluginDefinition = definePlugin({
  name: 'metrics',
  version: '0.1.0',
  engine: '<1.0.0',
  config: z.object({
    // Intervalo do flush periódico, em ms.
    flushIntervalMs: z.number().int().min(1000).default(60_000),
    // Dias de histórico mantidos; os mais antigos são apagados no flush.
    retentionDays: z.number().int().min(1).default(90),
    // Séries (combinações de rótulos) por métrica; passou, a amostra nova é descartada com aviso.
    maxSeriesPerMetric: z.number().int().min(1).default(1000),
  }),
  setup(ctx) {
    const exporters = ctx.services.extensionPoint('metrics.exporters');
    const runtime = createMetrics({
      collection: ctx.storage.collection<MetricDoc>('daily', { indexes: ['metric', 'day'] }),
      log: ctx.log,
      exporters: () => exporters.list(),
      maxSeriesPerMetric: ctx.config.maxSeriesPerMetric,
      retentionDays: ctx.config.retentionDays,
    });
    ctx.services.provide('metrics', runtime.service);
    const timer = setInterval(() => {
      // O flush já registra falhas de gravação e de exportador; isto evita rejeição solta.
      runtime
        .flush()
        .catch((error: unknown) => ctx.log.error('flush de métricas falhou', { error }));
    }, ctx.config.flushIntervalMs);
    timer.unref();
    ctx.signal.addEventListener('abort', () => clearInterval(timer), { once: true });
    runtimes.set(ctx.signal, { runtime, timer });
  },
  async teardown(ctx) {
    const entry = runtimes.get(ctx.signal);
    if (!entry) return;
    clearInterval(entry.timer);
    await entry.runtime.flush();
  },
});
