// Runtime do Node (#239): coletor padrão do `prom-client` por processo no `/metrics` e gauges
// `bridger_runtime_*` no histórico. Arquivo próprio: a registry do runtime é singleton do módulo,
// e a ordem dos bots aqui decide a config que vale para o processo.

import { PerformanceObserver } from 'node:perf_hooks';
import { createHttp, definePlugin, type Logger, type PluginDefinition } from '@usebridger/core';
import { createTestBot } from '@usebridger/testing';
import { collectDefaultMetrics } from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MetricsService, metrics } from './index.ts';
import { createRuntimeSampler, nodeRegistry } from './node-runtime.ts';

// Conta as chamadas ao coletor padrão, que segue real.
vi.mock('prom-client', async (original) => {
  const real = await original<typeof import('prom-client')>();
  return { ...real, collectDefaultMetrics: vi.fn(real.collectDefaultMetrics) };
});

function fakeLog(): { log: Logger; events: string[] } {
  const events: string[] = [];
  const log: Logger = {
    level: 'info',
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    event: (event) => void events.push(event.name),
    child: () => log,
  };
  return { log, events };
}

function consumer(): { plugin: PluginDefinition; get: () => MetricsService } {
  let service: MetricsService | undefined;
  const plugin = definePlugin({
    name: 'consumidor',
    version: '1.0.0',
    engine: '<1.0.0',
    dependsOn: { metrics: '*' },
    setup(ctx) {
      service = ctx.services.get('metrics');
    },
  });
  return {
    plugin,
    get: () => {
      if (!service) throw new Error('serviço não provido');
      return service;
    },
  };
}

async function scrape(port: number | undefined): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/plugins/metrics/metrics`);
  expect(res.status).toBe(200);
  return res.text();
}

const FAMILIES = [
  'process_cpu_user_seconds_total',
  'process_resident_memory_bytes',
  'nodejs_heap_size_used_bytes',
  'nodejs_eventloop_lag_p99_seconds',
  'nodejs_gc_duration_seconds',
];

const helpCount = (body: string, name: string) =>
  body.split('\n').filter((line) => line.startsWith(`# HELP ${name} `)).length;

const RUNTIME_GAUGES = [
  'bridger_runtime_rss_bytes',
  'bridger_runtime_heap_used_bytes',
  'bridger_runtime_eventloop_lag_p99_seconds',
  'bridger_runtime_cpu_ratio',
  'bridger_runtime_active_handles',
];

const today = (m: MetricsService, name: string) =>
  m.query({ name, from: '2026-10-17', to: '2026-10-17', granularity: 'day' });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GET /metrics com o runtime', () => {
  it('expõe as famílias padrão uma vez só, com dois bots e reload do plugin', async () => {
    const httpA = createHttp({ port: 0, hostname: '127.0.0.1' });
    const httpB = createHttp({ port: 0, hostname: '127.0.0.1' });
    const a = await createTestBot({ plugins: [metrics], http: httpA });
    const b = await createTestBot({ plugins: [metrics], http: httpB });
    await a.bot.plugins.reload('metrics');
    expect(collectDefaultMetrics).toHaveBeenCalledOnce();

    for (const port of [httpA.port, httpB.port]) {
      const body = await scrape(port);
      for (const name of FAMILIES) expect(helpCount(body, name)).toBe(1);
      expect(body).toContain('# TYPE bridger_inbound_pending gauge');
    }
    await a.stop();
    await b.stop();
  });

  it('o último bot a parar desliga o coletor e o próximo o recria', async () => {
    const disable = vi.spyOn(PerformanceObserver.prototype, 'disconnect');
    const calls = vi.mocked(collectDefaultMetrics).mock.calls.length;
    const a = await createTestBot({ plugins: [metrics] });
    const b = await createTestBot({ plugins: [metrics] });
    await a.stop();
    expect(disable).not.toHaveBeenCalled();
    await b.stop();
    expect(disable).toHaveBeenCalled();

    const c = await createTestBot({ plugins: [metrics] });
    expect(collectDefaultMetrics).toHaveBeenCalledTimes(calls + 2);
    await c.stop();
  });

  it('config divergente entre bots gera warn uma vez', async () => {
    const { log, events } = fakeLog();
    const first = await createTestBot({ plugins: [metrics] });
    const second = await createTestBot({
      plugins: [metrics],
      logger: log,
      pluginConfig: { metrics: { runtime: { eventLoopMonitoringPrecision: 20 } } },
    });
    const third = await createTestBot({
      plugins: [metrics],
      logger: log,
      pluginConfig: { metrics: { runtime: { gcDurationBuckets: [1, 2] } } },
    });
    expect(events.filter((e) => e === 'metrics.runtime.config-ignored')).toHaveLength(1);
    await first.stop();
    await second.stop();
    await third.stop();
  });

  it('falha ao ler a registry do runtime vai pro log e o resto do /metrics sai', async () => {
    const { log, events } = fakeLog();
    const http = createHttp({ port: 0, hostname: '127.0.0.1' });
    const bot = await createTestBot({ plugins: [metrics], http, logger: log });
    vi.spyOn(nodeRegistry({ eventLoopMonitoringPrecision: 10 }, log), 'metrics').mockRejectedValue(
      new Error('falha simulada'),
    );

    const body = await scrape(http.port);
    expect(body).toContain('# TYPE bridger_inbound_pending gauge');
    expect(body).not.toContain('process_');
    expect(events).toContain('metrics.runtime.scrape-failed');
    await bot.stop();
  });
});

describe('histórico do runtime', () => {
  const FAST = (runtime: object = {}) => ({ metrics: { flushIntervalMs: 1000, runtime } });

  it('grava os gauges bridger_runtime_* no flush', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-10-17T12:30:00Z'));
    const { plugin, get } = consumer();
    const bot = await createTestBot({ plugins: [metrics, plugin], pluginConfig: FAST() });
    await vi.advanceTimersByTimeAsync(1000);

    const names = (await get().catalog()).map((d) => d.name);
    for (const name of RUNTIME_GAUGES) {
      expect(names).toContain(name);
      const [row] = await today(get(), name);
      expect(row).toMatchObject({ type: 'gauge' });
      expect(row?.type === 'gauge' && row.max >= 0).toBe(true);
    }
    const [rss] = await today(get(), 'bridger_runtime_rss_bytes');
    expect(rss?.type === 'gauge' && rss.last > 0).toBe(true);
    await bot.stop();
  });

  it('enabled: false tira o runtime do /metrics e do histórico daquele bot', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-10-17T12:30:00Z'));
    const http = createHttp({ port: 0, hostname: '127.0.0.1' });
    const { plugin, get } = consumer();
    const bot = await createTestBot({
      plugins: [metrics, plugin],
      http,
      pluginConfig: FAST({ enabled: false }),
    });
    await vi.advanceTimersByTimeAsync(1000);

    const body = await scrape(http.port);
    expect(body).not.toMatch(/process_|nodejs_/);
    expect(body).toContain('# TYPE bridger_inbound_pending gauge');
    const names = (await get().catalog()).map((d) => d.name);
    for (const name of RUNTIME_GAUGES) {
      expect(names).not.toContain(name);
      expect(await today(get(), name)).toEqual([]);
    }
    await bot.stop();
  });
});

describe('amostrador', () => {
  it('cpu_ratio entre dois flushes; o peek não fecha a janela', () => {
    let now = 0;
    let cpu = { user: 0, system: 0 };
    const sampler = createRuntimeSampler({
      precisionMs: 10,
      log: fakeLog().log,
      now: () => now,
      cpuUsage: () => cpu,
    });
    const ratio = (consume: boolean) =>
      sampler.sample(consume).find((s) => s.metric === 'bridger_runtime_cpu_ratio')?.fields['last'];

    now = 1000; // 1 s de parede
    cpu = { user: 300_000, system: 200_000 }; // 0,5 s de CPU
    expect(ratio(false)).toBe(0.5);
    expect(ratio(true)).toBe(0.5);
    now = 2000;
    cpu = { user: 1_300_000, system: 700_000 }; // 1,5 s de CPU no segundo: vários núcleos
    expect(ratio(true)).toBe(1.5);
    sampler.stop();
  });

  it('fonte que falha vai pro log e as outras seguem', () => {
    const { log, events } = fakeLog();
    vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
      throw new Error('falha simulada');
    });
    const sampler = createRuntimeSampler({ precisionMs: 10, log });
    const metricsOut = sampler.sample(true).map((s) => s.metric);
    sampler.stop();

    expect(metricsOut).toEqual([
      'bridger_runtime_eventloop_lag_p99_seconds',
      'bridger_runtime_cpu_ratio',
      'bridger_runtime_active_handles',
    ]);
    expect(events).toEqual(['metrics.runtime.sample-failed', 'metrics.runtime.sample-failed']);
  });
});
