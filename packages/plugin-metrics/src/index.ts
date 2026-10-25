import { createHash, timingSafeEqual } from 'node:crypto';
import { BotConfigError, definePlugin, type PluginDefinition, secret } from '@usebridger/core';
import { z } from '@usebridger/core/zod';
import { Gauge, Registry } from 'prom-client';
import { createActiveTracker } from '#active.ts';
import {
  type CatalogDoc,
  createHistory,
  createPeriods,
  type HistoryDoc,
  isTimeZone,
} from '#history.ts';
import {
  createRuntimeSampler,
  nodeRegistry,
  releaseNodeRegistry,
  runtimeDeclarations,
} from '#node-runtime.ts';
import { CORE_OWNER, createMetrics, type Declaration, type Sample } from '#service.ts';

export type {
  Counter,
  CounterQueryRow,
  CounterRow,
  Gauge,
  GaugeQueryRow,
  GaugeRow,
  Granularity,
  Histogram,
  HistogramQueryRow,
  HistogramRow,
  HistogramSpec,
  LabelValues,
  MetricDescriptor,
  MetricLabels,
  MetricQuery,
  MetricRow,
  MetricSpec,
  MetricsExporter,
  MetricsService,
  MetricsSnapshot,
  QueryRow,
} from '#types.ts';

import * as LOG from './log-events.ts';

// Os limites do histograma de tratamento de antes do ADR 0121 (5 ms … 30 s), agora em segundos.
const HANDLE_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

const sha256 = (text: string): Buffer => createHash('sha256').update(text).digest();

/** `Authorization: Bearer <token>` com o token certo, em tempo constante: o hash iguala o tamanho. */
function bearerMatches(request: Request, token: string): boolean {
  const given = /^Bearer (.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  return given !== undefined && timingSafeEqual(sha256(given), sha256(token));
}

// Um runtime por contexto: o mesmo objeto de plugin serve a vários bots e a reloads.
const runtimes = new WeakMap<
  object,
  { flush: () => Promise<void>; timer: NodeJS.Timeout; stop: () => void }
>();

/** Plugin oficial `metrics` (ADR 0103, ADR 0121): provê o serviço `metrics`. */
export const metrics: PluginDefinition = definePlugin({
  name: 'metrics',
  version: '0.1.0',
  engine: '<1.0.0',
  config: z.object({
    // Intervalo do flush do histórico, em ms.
    flushIntervalMs: z.number().int().min(1000).default(60_000),
    // Fuso IANA da virada da hora e do dia no histórico (e dos ativos do dia).
    timeZone: z.string().refine(isTimeZone, 'fuso IANA desconhecido').default('UTC'),
    // Dias mantidos em cada nível; o corte roda no primeiro flush do dia.
    retention: z
      .object({
        hourDays: z.number().int().min(1).default(7),
        dayDays: z.number().int().min(1).default(90),
      })
      .default({ hourDays: 7, dayDays: 90 }),
    // Séries (combinações de rótulos) por métrica; passou, a amostra nova é descartada com aviso.
    maxSeriesPerMetric: z.number().int().min(1).default(1000),
    // Runtime do Node (#239): o coletor padrão do `prom-client` no `/metrics` e gauges no histórico.
    runtime: z
      .object({
        enabled: z.boolean().default(true),
        // Resolução do atraso do event loop, em ms.
        eventLoopMonitoringPrecision: z.number().int().min(1).default(10),
        // Baldes do histograma de GC, em segundos; ausente, o padrão do `prom-client`.
        gcDurationBuckets: z.array(z.number().positive()).nonempty().optional(),
      })
      .default({ enabled: true, eventLoopMonitoringPrecision: 10 }),
    // Token do scrape (#240): com ele, o `GET /metrics` exige `Authorization: Bearer <token>`.
    scrapeToken: secret(z.string().min(16)).optional(),
  }),
  setup(ctx) {
    // Uma registry por runtime (bot e setup), nunca o `register` global: dois bots no mesmo
    // processo não se enxergam (ADR 0003), e o reload recomeça do zero.
    const registry = new Registry();
    const node = ctx.config.runtime.enabled
      ? {
          registry: nodeRegistry(ctx.config.runtime, ctx.log),
          sampler: createRuntimeSampler({
            precisionMs: ctx.config.runtime.eventLoopMonitoringPrecision,
            log: ctx.log,
          }),
          declarations: runtimeDeclarations,
        }
      : undefined;
    const periods = createPeriods(ctx.config.timeZone);
    const exporters = ctx.services.extensionPoint('metrics.exporters');
    const indexes = { indexes: ['metric', 'period'] };
    const active = createActiveTracker({ now: Date.now, dayOf: (ms) => periods(ms).day });
    const history = createHistory({
      hourly: ctx.storage.collection<HistoryDoc>('hourly', indexes),
      daily: ctx.storage.collection<HistoryDoc>('daily', indexes),
      catalog: ctx.storage.collection<CatalogDoc>('catalog', { indexes: ['name'] }),
      log: ctx.log,
      periods,
      retention: ctx.config.retention,
      collect: async () => [...(await runtime.collect()), ...sampled(), ...nodeSamples(true)],
      peek: async () => [...(await runtime.peek()), ...sampled(), ...nodeSamples(false)],
      live: () => [...runtime.declarations(), ...kernelGauges, ...(node?.declarations ?? [])],
      exporters: () => exporters.list(),
    });
    const runtime = createMetrics({
      registry,
      log: ctx.log,
      maxSeriesPerMetric: ctx.config.maxSeriesPerMetric,
      onDescribe: history.describe,
    });
    // Serviço com escopo (ADR 0112): cada plugin recebe uma instância que grava o nome dele como dono.
    ctx.services.provideScoped(
      'metrics',
      (caller) => ({ ...runtime.scoped(caller), query: history.query, catalog: history.catalog }),
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
    const ACTIVE_USERS = 'Usuários ativos hoje, desde o início do processo';
    const ACTIVE_GROUPS = 'Grupos ativos hoje, desde o início do processo';
    const OUTBOUND = 'Mensagens aguardando na fila de saída, somadas as prioridades';
    live('bridger_active_users', ACTIVE_USERS, () => active.sizes().users);
    live('bridger_active_groups', ACTIVE_GROUPS, () => active.sizes().groups);

    // Gauges do histórico amostrados no flush, fora do serviço: os ativos do dia e a fila de saída
    // (ADR 0113), amostrada no timer para a fila pausada ou ociosa também gerar amostra.
    const kernelGauges: Declaration[] = (
      [
        ['bridger_active_users', ACTIVE_USERS],
        ['bridger_active_groups', ACTIVE_GROUPS],
        ['bridger_outbound_pending', OUTBOUND],
      ] as const
    ).map(([name, help]) => ({
      name,
      type: 'gauge',
      help,
      labelNames: [],
      buckets: null,
      owner: CORE_OWNER,
    }));
    for (const d of [...kernelGauges, ...(node?.declarations ?? [])]) history.describe(d);
    const nodeSamples = (consume: boolean): Sample[] => node?.sampler.sample(consume) ?? [];
    const gauge = (metric: string, value: number): Sample => ({
      metric,
      type: 'gauge',
      labels: {},
      fields: { last: value, max: value },
    });
    const sampled = (): Sample[] => {
      const { users, groups } = active.sizes();
      const out = [gauge('bridger_active_users', users), gauge('bridger_active_groups', groups)];
      try {
        const { high, normal, low } = ctx.stats().outbound.pending;
        out.push(gauge('bridger_outbound_pending', high + normal + low));
      } catch (error) {
        // Sem a amostra da fila o resto do flush segue.
        ctx.log.event(LOG.sampleFailed, { err: error });
      }
      return out;
    };

    try {
      const { scrapeToken } = ctx.config;
      ctx.http.route('GET', '/metrics', async (request) => {
        // Corpo genérico: a recusa não diz se faltou o cabeçalho ou se o token estava errado.
        if (scrapeToken !== undefined && !bearerMatches(request, scrapeToken)) {
          return new Response('unauthorized', {
            status: 401,
            headers: { 'www-authenticate': 'Bearer' },
          });
        }
        let body = await registry.metrics();
        try {
          // Os prefixos `process_`/`nodejs_` são reservados, então os nomes não colidem.
          if (node) body += `\n${await node.registry.metrics()}`;
        } catch (error) {
          // Sem o runtime, as métricas do bot ainda saem.
          ctx.log.event(LOG.runtimeScrapeFailed, { err: error });
        }
        return new Response(body, { headers: { 'content-type': registry.contentType } });
      });
      if (scrapeToken === undefined) {
        ctx.log.event(LOG.scrapeOpen, { path: `${ctx.http.basePath}/metrics` });
      }
    } catch (error) {
      // Sem servidor HTTP o bot ainda mede; só o scrape fica indisponível.
      if (!(error instanceof BotConfigError)) throw error;
      ctx.log.event(LOG.httpMissing);
    }

    const timer = setInterval(() => {
      // O flush já registra falhas de gravação e de exportador; isto evita rejeição solta.
      history.flush().catch((error: unknown) => ctx.log.event(LOG.flushFailed, { err: error }));
    }, ctx.config.flushIntervalMs);
    timer.unref();
    // Roda no abort e no teardown; a registry do processo só pode ser solta uma vez por setup.
    let stopped = !node;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      node?.sampler.stop();
      releaseNodeRegistry();
    };
    ctx.signal.addEventListener(
      'abort',
      () => {
        clearInterval(timer);
        stop();
      },
      { once: true },
    );
    runtimes.set(ctx.signal, { flush: history.flush, timer, stop });
  },
  async teardown(ctx) {
    const entry = runtimes.get(ctx.signal);
    if (!entry) return;
    clearInterval(entry.timer);
    // Flush final: o que somou desde o último flush não se perde no stop nem no reload.
    try {
      await entry.flush();
    } finally {
      entry.stop();
    }
  },
});
