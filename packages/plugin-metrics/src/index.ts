import { BotConfigError, definePlugin, type PluginDefinition } from '@usebridger/core';
import { z } from '@usebridger/core/zod';
import { Gauge, Registry } from 'prom-client';
import { createActiveTracker } from '#active.ts';
import { createMetrics } from '#service.ts';

export type {
  Counter,
  CounterRow,
  Gauge,
  Histogram,
  HistogramRow,
  HistogramSpec,
  LabelValues,
  MetricLabels,
  MetricRow,
  MetricSpec,
  MetricsExporter,
  MetricsService,
  MetricsSnapshot,
} from '#types.ts';

import * as LOG from './log-events.ts';

// Os limites do histograma de tratamento de antes do ADR 0121 (5 ms … 30 s), agora em segundos.
const HANDLE_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/** Plugin oficial `metrics` (ADR 0103, ADR 0121): provê o serviço `metrics`. */
export const metrics: PluginDefinition = definePlugin({
  name: 'metrics',
  version: '0.1.0',
  engine: '<1.0.0',
  config: z.object({
    // Séries (combinações de rótulos) por métrica; passou, a amostra nova é descartada com aviso.
    maxSeriesPerMetric: z.number().int().min(1).default(1000),
  }),
  setup(ctx) {
    // Uma registry por runtime (bot e setup), nunca o `register` global: dois bots no mesmo
    // processo não se enxergam (ADR 0003), e o reload recomeça do zero.
    const registry = new Registry();
    const runtime = createMetrics({
      registry,
      log: ctx.log,
      maxSeriesPerMetric: ctx.config.maxSeriesPerMetric,
    });
    // Serviço com escopo (ADR 0112): cada plugin recebe uma instância que grava o nome dele como dono.
    ctx.services.provideScoped(
      'metrics',
      (caller) => runtime.scoped(caller),
      (caller) => runtime.release(caller),
    );
    // Decisão explícita: o que o próprio plugin-metrics declara (kernel) é do `core`, não do
    // plugin `metrics`, para separar kernel de plugin de terceiros.
    const m = runtime.service;

    // Rótulos só com dado de baixa cardinalidade e sem dado pessoal: nunca id de chat/usuário.
    const handled = m.counter({
      name: 'bridger_messages_handled_total',
      help: 'Mensagens tratadas pelo kernel',
      labelNames: ['chatType', 'route', 'status', 'command'],
    });
    const duration = m.histogram({
      name: 'bridger_message_handle_duration_seconds',
      help: 'Tempo de tratamento de uma mensagem, em segundos',
      labelNames: ['route', 'status'],
      buckets: HANDLE_BUCKETS,
    });
    const sent = m.counter({
      name: 'bridger_outbound_sent_total',
      help: 'Envios da fila de saída',
      labelNames: ['kind', 'status', 'chatType'],
    });
    const active = createActiveTracker({ now: Date.now });

    ctx.observe('message.handled', (s) => {
      handled.inc({
        chatType: s.chatType,
        route: s.route,
        status: s.status,
        ...(s.command === undefined ? {} : { command: s.command }),
      });
      duration.observe({ route: s.route, status: s.status }, s.durationMs / 1000);
      active.record(s.senderId, s.chatType === 'group' ? s.chatId : undefined);
    });
    ctx.observe('outbound.sent', (s) => {
      sent.inc({
        kind: s.kind,
        status: s.status,
        ...(s.chatType === undefined ? {} : { chatType: s.chatType }),
      });
    });

    // Gauges lidos no scrape (`collect`), direto no `prom-client` e fora do serviço: saúde das
    // filas e ativos do dia.
    const live = (name: string, help: string, read: () => number): void => {
      new Gauge({
        name,
        help,
        registers: [registry],
        collect() {
          this.set(read());
        },
      });
    };
    live(
      'bridger_inbound_pending',
      'Tarefas aguardando na fila de entrada',
      () => ctx.stats().inbound.pending,
    );
    live(
      'bridger_inbound_active_chats',
      'Chats com tarefa rodando',
      () => ctx.stats().inbound.activeChats,
    );
    new Gauge({
      name: 'bridger_outbound_pending',
      help: 'Mensagens aguardando na fila de saída, por prioridade',
      labelNames: ['priority'],
      registers: [registry],
      collect() {
        for (const [priority, value] of Object.entries(ctx.stats().outbound.pending)) {
          this.set({ priority }, value);
        }
      },
    });
    live('bridger_outbound_in_flight', 'Envios em andamento', () => ctx.stats().outbound.inFlight);
    live('bridger_outbound_paused', 'Fila de saída pausada (1) pela conexão caída', () =>
      ctx.stats().outbound.paused ? 1 : 0,
    );
    live(
      'bridger_active_users',
      'Usuários ativos hoje (UTC), desde o início do processo',
      () => active.sizes().users,
    );
    live(
      'bridger_active_groups',
      'Grupos ativos hoje (UTC), desde o início do processo',
      () => active.sizes().groups,
    );

    try {
      ctx.http.route(
        'GET',
        '/metrics',
        async () =>
          new Response(await registry.metrics(), {
            headers: { 'content-type': registry.contentType },
          }),
      );
    } catch (error) {
      // Sem servidor HTTP o bot ainda mede; só o scrape fica indisponível.
      if (!(error instanceof BotConfigError)) throw error;
      ctx.log.event(LOG.httpMissing);
    }
  },
});
