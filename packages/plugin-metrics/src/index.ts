import { BotConfigError, definePlugin, type PluginDefinition } from '@usebridger/core';
import { z } from '@usebridger/core/zod';
import { createActiveTracker } from '#active.ts';
import { type Gauge, renderPrometheus } from '#prometheus.ts';
import { createMetrics, type MetricDoc } from '#service.ts';

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
const runtimes = new WeakMap<object, { flush: () => Promise<void>; timer: NodeJS.Timeout }>();

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
    // Serviço com escopo (ADR 0116): cada plugin recebe uma instância que grava o nome dele como dono.
    ctx.services.provideScoped(
      'metrics',
      (caller) => runtime.scoped(caller),
      (caller) => runtime.release(caller),
    );
    // Decisão explícita: o que o próprio plugin-metrics grava (observadores do kernel) é do `core`,
    // não do plugin `metrics`, para a coluna "Plugin" separar kernel de plugin de terceiros.
    const m = runtime.service;

    const active = createActiveTracker({
      now: Date.now,
      add: (metric, value, day) => runtime.counterAt(`bridger.active.${metric}`, {}, value, day),
    });
    // Os ativos entram no agregado só aqui, como delta: o flush nunca soma a mesma contagem duas vezes.
    const flush = async (): Promise<void> => {
      try {
        // Fila de saída amostrada no timer, não no envio: fila pausada ou ociosa também gera amostra.
        const { high, normal, low } = ctx.stats().outbound.pending;
        m.gauge('bridger.outbound.pending', {}, high + normal + low);
      } catch (error) {
        ctx.log.error('falha ao amostrar a fila de saída', { error });
      }
      try {
        active.sync();
      } catch (error) {
        // Não impede o flush do resto; o delta fica no tracker e entra no próximo.
        ctx.log.error('falha ao somar ativos do dia ao agregado', { error });
      }
      await runtime.flush();
    };

    // Rótulos só com dado de baixa cardinalidade e sem dado pessoal: nunca id de chat/usuário.
    ctx.observe('message.handled', (s) => {
      m.counter('bridger.messages.handled', {
        chatType: s.chatType,
        route: s.route,
        status: s.status,
        ...(s.command === undefined ? {} : { command: s.command }),
      });
      m.observe(
        'bridger.messages.handle_duration_ms',
        { route: s.route, status: s.status },
        s.durationMs,
      );
      active.record(s.senderId, s.chatType === 'group' ? s.chatId : undefined);
    });
    ctx.observe('outbound.sent', (s) => {
      m.counter('bridger.outbound.sent', {
        kind: s.kind,
        status: s.status,
        ...(s.chatType === undefined ? {} : { chatType: s.chatType }),
      });
    });

    // Gauges lidos no scrape: filas de entrada e de saída (saúde da fila) e ativos do dia.
    const gauges = (): Gauge[] => {
      const { inbound, outbound } = ctx.stats();
      const { users, groups } = active.sizes();
      const one = (name: string, help: string, value: number): Gauge => ({
        name,
        help,
        samples: [{ labels: {}, value }],
      });
      return [
        one('bridger_inbound_pending', 'Tarefas aguardando na fila de entrada', inbound.pending),
        one('bridger_inbound_active_chats', 'Chats com tarefa rodando', inbound.activeChats),
        {
          name: 'bridger_outbound_pending',
          help: 'Mensagens aguardando na fila de saída, por prioridade',
          samples: Object.entries(outbound.pending).map(([priority, value]) => ({
            labels: { priority },
            value,
          })),
        },
        one('bridger_outbound_in_flight', 'Envios em andamento', outbound.inFlight),
        one(
          'bridger_outbound_paused',
          'Fila de saída pausada (1) pela conexão caída',
          outbound.paused ? 1 : 0,
        ),
        one(
          'bridger_active_users',
          'Usuários ativos hoje (UTC), desde o início do processo',
          users,
        ),
        one(
          'bridger_active_groups',
          'Grupos ativos hoje (UTC), desde o início do processo',
          groups,
        ),
      ];
    };
    try {
      ctx.http.route(
        'GET',
        '/metrics',
        () =>
          new Response(
            renderPrometheus(runtime.totals(), gauges(), (name) =>
              ctx.log.warn('métrica fora do /metrics: nome saneado colide com outro tipo', {
                name,
              }),
            ),
            {
              headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
            },
          ),
      );
    } catch (error) {
      // Sem servidor HTTP o bot ainda mede e grava; só o scrape fica indisponível.
      if (!(error instanceof BotConfigError)) throw error;
      ctx.log.info('sem http no bot: GET /metrics desligado');
    }

    const timer = setInterval(() => {
      // O flush já registra falhas de gravação e de exportador; isto evita rejeição solta.
      flush().catch((error: unknown) => ctx.log.error('flush de métricas falhou', { error }));
    }, ctx.config.flushIntervalMs);
    timer.unref();
    ctx.signal.addEventListener('abort', () => clearInterval(timer), { once: true });
    runtimes.set(ctx.signal, { flush, timer });
  },
  async teardown(ctx) {
    const entry = runtimes.get(ctx.signal);
    if (!entry) return;
    clearInterval(entry.timer);
    await entry.flush();
  },
});
