// Histórico por hora e dia (ADR 0121): flush do delta da registry, períodos no fuso, gauges,
// ativos, retenção, exportadores e catálogo. Lê as coleções direto, sem a API de leitura (#238).

import {
  type CollectionOptions,
  createMemoryStorage,
  definePlugin,
  type Logger,
  type PluginDefinition,
  type StoragePort,
} from '@usebridger/core';
import { createTestBot } from '@usebridger/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPeriods, type HistoryDoc } from './history.ts';
import { type MetricsExporter, type MetricsService, metrics } from './index.ts';

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

// Consumidor que declara as métricas no setup e contribui com exportadores, como um app faria.
function consumer(exporters: MetricsExporter[] = []): {
  plugin: PluginDefinition;
  get: () => MetricsService;
} {
  let service: MetricsService | undefined;
  const plugin = definePlugin({
    name: 'consumidor',
    version: '1.0.0',
    engine: '<1.0.0',
    dependsOn: { metrics: '*' },
    setup(ctx) {
      service = ctx.services.get('metrics');
      for (const e of exporters) ctx.services.contribute('metrics.exporters', e);
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

// Storage em memória que o `stop()` não fecha (o teste lê depois) e que falha sob encomenda:
// `failing.add('hourly.increment')` faz o `increment` da coleção `hourly` rejeitar.
function testStorage(): { storage: StoragePort; failing: Set<string> } {
  const real = createMemoryStorage();
  const failing = new Set<string>();
  // Repassa tudo preso ao original, trocando só o que `override` devolver.
  const wrap = <T extends object>(target: T, override: (key: string | symbol) => unknown): T =>
    new Proxy(target, {
      get(t, key) {
        const replaced = override(key);
        if (replaced !== undefined) return replaced;
        const value: unknown = Reflect.get(t, key, t);
        return typeof value === 'function' ? value.bind(t) : value;
      },
    });
  const storage = wrap(real, (key) => {
    if (key === 'close') return async () => undefined;
    if (key !== 'forNamespace') return undefined;
    return (namespace: string) => {
      const ns = real.forNamespace(namespace);
      return wrap(ns, (k) =>
        k === 'collection'
          ? (name: string, options?: CollectionOptions) =>
              wrap(ns.collection(name, options), (method) =>
                failing.has(`${name}.${String(method)}`)
                  ? () => Promise.reject(new Error('falha simulada'))
                  : undefined,
              )
          : undefined,
      );
    };
  });
  return { storage, failing };
}

const coll = (storage: StoragePort, name: string) =>
  storage.forNamespace('metrics').collection<HistoryDoc>(name);

// Valor gravado de (métrica, campo) por período, somando as séries.
async function read(
  storage: StoragePort,
  level: 'hourly' | 'daily',
  metric: string,
  field = 'value',
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const d of await coll(storage, level).find({ where: { metric, field } })) {
    out[d.period] = (out[d.period] ?? 0) + d.value;
  }
  return out;
}

const counter = (m: MetricsService) =>
  m.counter({ name: 'app_x_total', help: 'x', labelNames: ['k'] });

beforeEach(() => {
  // Só relógio e intervalo: o resto (promises do storage) segue real.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-17T12:30:00Z'));
});
afterEach(() => vi.useRealTimers());

const FAST = { metrics: { flushIntervalMs: 1000 } };

describe('flush', () => {
  it('grava o delta na hora e no dia sem duplicar entre flushes', async () => {
    const { storage } = testStorage();
    const { plugin, get } = consumer();
    const bot = await createTestBot({ plugins: [metrics, plugin], storage, pluginConfig: FAST });
    const x = counter(get());

    x.inc({ k: 'a' }, 3);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000); // sem novidade: não soma de novo
    x.inc({ k: 'a' }, 4);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await read(storage, 'hourly', 'app_x_total')).toEqual({ '2026-10-17T12': 7 });
    expect(await read(storage, 'daily', 'app_x_total')).toEqual({ '2026-10-17': 7 });
    // Um documento por (métrica, período, série, campo).
    expect(await coll(storage, 'hourly').find({ where: { metric: 'app_x_total' } })).toHaveLength(
      1,
    );
    await bot.stop();
  });

  it('histograma grava baldes não cumulativos, sum e count', async () => {
    const { storage } = testStorage();
    const { plugin, get } = consumer();
    const bot = await createTestBot({ plugins: [metrics, plugin], storage, pluginConfig: FAST });
    const h = get().histogram({
      name: 'app_lat_seconds',
      help: 'h',
      labelNames: [],
      buckets: [0.1, 1],
    });

    h.observe({}, 0.05);
    h.observe({}, 0.5);
    h.observe({}, 5);
    await vi.advanceTimersByTimeAsync(1000);
    h.observe({}, 0.5);
    await vi.advanceTimersByTimeAsync(1000);

    const day = (field: string) => read(storage, 'daily', 'app_lat_seconds', field);
    expect(await day('le:0.1')).toEqual({ '2026-10-17': 1 });
    expect(await day('le:1')).toEqual({ '2026-10-17': 2 });
    expect(await day('le:+Inf')).toEqual({ '2026-10-17': 1 });
    expect(await day('count')).toEqual({ '2026-10-17': 4 });
    expect(await day('sum')).toEqual({ '2026-10-17': 6.05 });
    await bot.stop();
  });

  it('gravação que falha fica pendente e entra no flush seguinte, sem somar duas vezes', async () => {
    const { storage, failing } = testStorage();
    const { plugin, get } = consumer();
    const { log, events } = fakeLog();
    const bot = await createTestBot({
      plugins: [metrics, plugin],
      storage,
      logger: log,
      pluginConfig: FAST,
    });
    const x = counter(get());
    failing.add('hourly.increment');

    x.inc({ k: 'a' }, 2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toContain('metrics.write.failed');
    expect(await read(storage, 'daily', 'app_x_total')).toEqual({ '2026-10-17': 2 });
    failing.delete('hourly.increment');
    x.inc({ k: 'a' }, 1);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await read(storage, 'hourly', 'app_x_total')).toEqual({ '2026-10-17T12': 3 });
    expect(await read(storage, 'daily', 'app_x_total')).toEqual({ '2026-10-17': 3 });
    await bot.stop();
  });

  it('flush final no stop grava o que sobrou e sobrevive ao restart', async () => {
    const { storage } = testStorage();
    const { plugin, get } = consumer();
    const bot = await createTestBot({ plugins: [metrics, plugin], storage });
    counter(get()).inc({ k: 'a' }, 9);

    const bot2 = await bot.restart();
    counter(get()).inc({ k: 'a' }, 1);
    await bot2.stop();

    expect(await read(storage, 'daily', 'app_x_total')).toEqual({ '2026-10-17': 10 });
  });

  it('para o intervalo no stop', async () => {
    const bot = await createTestBot({ plugins: [metrics] });
    await bot.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reload do plugin: a registry recomeça e o histórico não soma em dobro', async () => {
    const { storage } = testStorage();
    const { plugin, get } = consumer();
    const bot = await createTestBot({ plugins: [metrics, plugin], storage, pluginConfig: FAST });
    counter(get()).inc({ k: 'a' }, 3);
    await vi.advanceTimersByTimeAsync(1000);

    await bot.bot.plugins.reload('metrics');
    counter(get()).inc({ k: 'a' }, 2);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await read(storage, 'daily', 'app_x_total')).toEqual({ '2026-10-17': 5 });
    await bot.stop();
  });

  it('métrica que sai com o dono tem o delta gravado no flush seguinte', async () => {
    const { storage } = testStorage();
    const { plugin, get } = consumer();
    const bot = await createTestBot({ plugins: [metrics, plugin], storage, pluginConfig: FAST });
    counter(get()).inc({ k: 'a' }, 3);

    await bot.bot.plugins.reload('consumidor'); // tira a métrica da registry
    counter(get()).inc({ k: 'a' }, 2); // volta zerada, com base nova
    await vi.advanceTimersByTimeAsync(1000);

    expect(await read(storage, 'daily', 'app_x_total')).toEqual({ '2026-10-17': 5 });
    await bot.stop();
  });
});

describe('período', () => {
  it('vira a hora e o dia', async () => {
    const { storage } = testStorage();
    const { plugin, get } = consumer();
    const bot = await createTestBot({ plugins: [metrics, plugin], storage, pluginConfig: FAST });
    const x = counter(get());

    vi.setSystemTime(new Date('2026-10-17T22:59:58Z'));
    x.inc({ k: 'a' }, 1);
    await vi.advanceTimersByTimeAsync(1000);
    vi.setSystemTime(new Date('2026-10-17T23:00:30Z'));
    x.inc({ k: 'a' }, 2);
    await vi.advanceTimersByTimeAsync(1000);
    vi.setSystemTime(new Date('2026-10-18T00:00:30Z'));
    x.inc({ k: 'a' }, 4);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await read(storage, 'hourly', 'app_x_total')).toEqual({
      '2026-10-17T22': 1,
      '2026-10-17T23': 2,
      '2026-10-18T00': 4,
    });
    expect(await read(storage, 'daily', 'app_x_total')).toEqual({
      '2026-10-17': 3,
      '2026-10-18': 4,
    });
    await bot.stop();
  });

  it('segue o timeZone da config', async () => {
    const { storage } = testStorage();
    const { plugin, get } = consumer();
    const bot = await createTestBot({
      plugins: [metrics, plugin],
      storage,
      pluginConfig: { metrics: { flushIntervalMs: 1000, timeZone: 'America/Sao_Paulo' } },
    });
    vi.setSystemTime(new Date('2026-10-18T02:30:00Z')); // 23:30 do dia 17 em São Paulo
    counter(get()).inc({ k: 'a' }, 1);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await read(storage, 'hourly', 'app_x_total')).toEqual({ '2026-10-17T23': 1 });
    expect(await read(storage, 'daily', 'app_x_total')).toEqual({ '2026-10-17': 1 });
    await bot.stop();
  });

  it('recusa fuso desconhecido na config', async () => {
    await expect(
      createTestBot({
        plugins: [metrics],
        pluginConfig: { metrics: { timeZone: 'Marte/Olimpo' } },
      }),
    ).rejects.toThrow();
  });

  it('createPeriods formata a hora em 00–23', () => {
    expect(createPeriods('UTC')(Date.parse('2026-10-17T00:05:00Z'))).toEqual({
      day: '2026-10-17',
      hour: '2026-10-17T00',
    });
  });
});

describe('gauge', () => {
  it('grava last e max do período, e o max só sobe', async () => {
    const { storage } = testStorage();
    const { plugin, get } = consumer();
    const bot = await createTestBot({ plugins: [metrics, plugin], storage, pluginConfig: FAST });
    const g = get().gauge({ name: 'app_fila', help: 'f', labelNames: [] });

    g.set({}, 5);
    g.set({}, 9);
    g.set({}, 2);
    await vi.advanceTimersByTimeAsync(1000);
    g.set({}, 4);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await read(storage, 'hourly', 'app_fila', 'last')).toEqual({ '2026-10-17T12': 4 });
    expect(await read(storage, 'hourly', 'app_fila', 'max')).toEqual({ '2026-10-17T12': 9 });
    expect(await read(storage, 'daily', 'app_fila', 'max')).toEqual({ '2026-10-17': 9 });
    await bot.stop();
  });
});

describe('ativos e fila de saída', () => {
  it('ativos viram gauge diário e recomeçam na virada do dia', async () => {
    const { storage } = testStorage();
    const bot = await createTestBot({ plugins: [metrics], storage, pluginConfig: FAST });
    vi.setSystemTime(new Date('2026-10-17T23:59:00Z'));
    await bot.receive({ text: 'oi', sender: { id: 'ana@fake' } });
    await bot.receive({ text: 'oi', sender: { id: 'bia@fake' } });
    await vi.advanceTimersByTimeAsync(1000);
    vi.setSystemTime(new Date('2026-10-18T00:00:30Z'));
    await bot.receive({ text: 'oi', sender: { id: 'ana@fake' } });
    await vi.advanceTimersByTimeAsync(1000);

    expect(await read(storage, 'daily', 'bridger_active_users', 'max')).toEqual({
      '2026-10-17': 2,
      '2026-10-18': 1,
    });
    expect(await read(storage, 'daily', 'bridger_outbound_pending', 'last')).toEqual({
      '2026-10-17': 0,
      '2026-10-18': 0,
    });
    await bot.stop();
  });
});

describe('retenção', () => {
  it('corta hora e dia mais antigos que a config no primeiro flush do dia', async () => {
    const { storage } = testStorage();
    const { plugin, get } = consumer();
    const bot = await createTestBot({
      plugins: [metrics, plugin],
      storage,
      pluginConfig: { metrics: { flushIntervalMs: 1000, retention: { hourDays: 1, dayDays: 2 } } },
    });
    const x = counter(get());

    x.inc({ k: 'a' }, 1); // 2026-10-17T12
    await vi.advanceTimersByTimeAsync(1000);
    vi.setSystemTime(new Date('2026-10-18T13:00:00Z'));
    x.inc({ k: 'a' }, 1); // corte da hora: 2026-10-17T13
    await vi.advanceTimersByTimeAsync(1000);
    expect(Object.keys(await read(storage, 'hourly', 'app_x_total'))).toEqual(['2026-10-18T13']);
    expect(Object.keys(await read(storage, 'daily', 'app_x_total'))).toEqual([
      '2026-10-17',
      '2026-10-18',
    ]);

    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    x.inc({ k: 'a' }, 1); // corte do dia: 2026-10-18
    await vi.advanceTimersByTimeAsync(1000);
    expect(Object.keys(await read(storage, 'daily', 'app_x_total'))).toEqual([
      '2026-10-18',
      '2026-10-20',
    ]);
    await bot.stop();
  });
});

describe('metrics.exporters', () => {
  it('entrega o snapshot gravado; erro de um vai pro log e não impede os outros', async () => {
    const seen: unknown[] = [];
    const ruim: MetricsExporter = () => {
      throw new Error('boom');
    };
    const bom: MetricsExporter = (s) => void seen.push(s);
    const { plugin, get } = consumer([ruim, bom]);
    const { log, events } = fakeLog();
    const bot = await createTestBot({
      plugins: [metrics, plugin],
      logger: log,
      pluginConfig: FAST,
    });
    const x = counter(get());
    // Fora os gauges amostrados no flush, que sempre saem.
    const mine = () =>
      seen.map((s) => ({
        ...(s as object),
        rows: (s as { rows: { metric: string }[] }).rows.filter((r) => r.metric === 'app_x_total'),
      }));

    x.inc({ k: 'a' }, 2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mine()).toEqual([
      {
        at: '2026-10-17T12:30:01.000Z',
        rows: [
          {
            metric: 'app_x_total',
            type: 'counter',
            granularity: 'hour',
            period: '2026-10-17T12',
            labels: { k: 'a' },
            value: 2,
          },
          {
            metric: 'app_x_total',
            type: 'counter',
            granularity: 'day',
            period: '2026-10-17',
            labels: { k: 'a' },
            value: 2,
          },
        ],
      },
    ]);
    expect(events).toContain('metrics.exporter.failed');
    await bot.stop();
  });

  it('flush sem linha gravada não chama exportador', async () => {
    const seen: unknown[] = [];
    const { plugin } = consumer([(s) => void seen.push(s)]);
    const { storage, failing } = testStorage();
    const bot = await createTestBot({ plugins: [metrics, plugin], storage, pluginConfig: FAST });
    // Sem gravação nenhuma: os gauges amostrados também falham.
    for (const c of ['hourly', 'daily']) {
      for (const m of ['update', 'find']) failing.add(`${c}.${m}`);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual([]);
    await bot.stop();
  });
});

describe('catálogo', () => {
  it('grava o descritor na primeira declaração e troca o dono quando ele sai', async () => {
    const { storage } = testStorage();
    const { plugin, get } = consumer();
    const outro = definePlugin({
      name: 'outro',
      version: '1.0.0',
      engine: '<1.0.0',
      dependsOn: { metrics: '*' },
      setup(ctx) {
        ctx.services.get('metrics').counter({ name: 'app_x_total', help: 'x', labelNames: ['k'] });
      },
    });
    const bot = await createTestBot({ plugins: [metrics, plugin, outro], storage });
    get().histogram({
      name: 'app_lat_seconds',
      help: 'Latência',
      labelNames: ['ok'],
      buckets: [1],
    });
    counter(get()); // segundo a declarar: vira o dono quando "outro" sai
    await bot.bot.plugins.disable('outro');
    await bot.stop();

    const docs = await coll(storage, 'catalog').find();
    const byName = Object.fromEntries(docs.map(({ id: _, ...d }) => [d['name'], d]));
    expect(byName['app_lat_seconds']).toEqual({
      name: 'app_lat_seconds',
      type: 'histogram',
      help: 'Latência',
      labelNames: ['ok'],
      buckets: [1],
      owner: 'consumidor',
    });
    expect(byName['app_x_total']).toMatchObject({ owner: 'consumidor' });
    expect(byName['bridger_messages_handled_total']).toMatchObject({ owner: 'core' });
    expect(byName['bridger_active_users']).toMatchObject({ type: 'gauge', owner: 'core' });
  });
});
