// Métricas do runtime do Node (#239): o `collectDefaultMetrics` do `prom-client` no `/metrics` e
// um amostrador próprio para o histórico.

import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Logger } from '@usebridger/core';
import { collectDefaultMetrics, Registry } from 'prom-client';
import { CORE_OWNER, type Declaration, type Sample } from '#service.ts';
import * as LOG from './log-events.ts';

export interface NodeRuntimeConfig {
  readonly eventLoopMonitoringPrecision: number;
  readonly gcDurationBuckets?: readonly number[] | undefined;
}

// Uma registry por processo: o `collectDefaultMetrics` liga o `monitorEventLoopDelay` e o observer
// de GC sem oferecer `stop`, então ela vive até o fim do processo e serve a todo bot e reload.
let shared: { registry: Registry; key: string; warned: boolean } | undefined;

/** A registry do runtime, criada na primeira chamada com a config dela; as seguintes a reaproveitam. */
export function nodeRegistry(config: NodeRuntimeConfig, log: Logger): Registry {
  const key = JSON.stringify([config.eventLoopMonitoringPrecision, config.gcDurationBuckets]);
  if (!shared) {
    const registry = new Registry();
    collectDefaultMetrics({
      register: registry,
      eventLoopMonitoringPrecision: config.eventLoopMonitoringPrecision,
      ...(config.gcDurationBuckets ? { gcDurationBuckets: [...config.gcDurationBuckets] } : {}),
    });
    shared = { registry, key, warned: false };
  } else if (key !== shared.key && !shared.warned) {
    shared.warned = true;
    log.event(LOG.runtimeConfigIgnored);
  }
  return shared.registry;
}

const GAUGES = [
  ['bridger_runtime_rss_bytes', 'Memória residente do processo, em bytes'],
  ['bridger_runtime_heap_used_bytes', 'Heap V8 em uso, em bytes'],
  [
    'bridger_runtime_eventloop_lag_p99_seconds',
    'p99 do atraso do event loop desde o flush anterior',
  ],
  ['bridger_runtime_cpu_ratio', 'CPU do processo ÷ tempo de parede desde o flush anterior'],
  ['bridger_runtime_active_handles', 'Recursos ativos que seguram o event loop'],
] as const;

/** Descritores dos gauges do runtime no histórico, do kernel. */
export const runtimeDeclarations: readonly Declaration[] = GAUGES.map(([name, help]) => ({
  name,
  type: 'gauge',
  help,
  labelNames: [],
  buckets: null,
  owner: CORE_OWNER,
}));

export interface RuntimeSamplerOptions {
  readonly precisionMs: number;
  readonly log: Logger;
  /** Relógio de parede em ms; trocado no teste. */
  readonly now?: () => number;
  /** CPU acumulada do processo em µs; trocada no teste. */
  readonly cpuUsage?: () => NodeJS.CpuUsage;
}

export interface RuntimeSampler {
  /** Lê as fontes; com `consume`, fecha a janela do atraso e da CPU (o flush, não o `peek`). */
  sample(consume: boolean): Sample[];
  stop(): void;
}

/**
 * Amostrador do histórico com fonte própria, não a registry do `prom-client`: ela zera o histograma
 * do event loop a cada leitura, e o flush e o scrape roubariam a janela um do outro.
 */
export function createRuntimeSampler(options: RuntimeSamplerOptions): RuntimeSampler {
  const now = options.now ?? (() => performance.now());
  const cpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
  const lag = monitorEventLoopDelay({ resolution: options.precisionMs });
  lag.enable();
  let last = { at: now(), cpu: cpuUsage() };

  const sources: Record<(typeof GAUGES)[number][0], (consume: boolean) => number> = {
    bridger_runtime_rss_bytes: () => process.memoryUsage().rss,
    bridger_runtime_heap_used_bytes: () => process.memoryUsage().heapUsed,
    bridger_runtime_eventloop_lag_p99_seconds: (consume) => {
      const p99 = lag.count === 0 ? 0 : lag.percentile(99) / 1e9;
      if (consume) lag.reset();
      return p99;
    },
    bridger_runtime_cpu_ratio: (consume) => {
      const at = now();
      const cpu = cpuUsage();
      const used = cpu.user - last.cpu.user + (cpu.system - last.cpu.system);
      const wall = (at - last.at) * 1000;
      if (consume) last = { at, cpu };
      // Pode passar de 1 com threads em vários núcleos.
      return wall > 0 ? used / wall : 0;
    },
    bridger_runtime_active_handles: () => process.getActiveResourcesInfo().length,
  };

  return {
    sample(consume) {
      const out: Sample[] = [];
      for (const [metric] of GAUGES) {
        try {
          const value = sources[metric](consume);
          out.push({ metric, type: 'gauge', labels: {}, fields: { last: value, max: value } });
        } catch (error) {
          // Uma fonte que falha só tira a amostra dela; o resto do flush segue.
          options.log.event(LOG.runtimeSampleFailed, { err: error, metric });
        }
      }
      return out;
    },
    stop: () => lag.disable(),
  };
}
