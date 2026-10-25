// Leitura do histórico (ADR 0121, #238): `query` com o gravado mais o delta da registry, `where`,
// `groupBy`, percentil interpolado, gauge agrupado, concorrência com o flush e `catalog()`.

import {
  type CollectionOptions,
  createMemoryStorage,
  definePlugin,
  type PluginDefinition,
  type StoragePort,
} from '@usebridger/core';
import { createTestBot } from '@usebridger/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type HistoryDoc, quantile } from './history.ts';
import { type MetricQuery, type MetricsService, metrics } from './index.ts';

// Consumidor que declara as métricas, como um app faria.
function consumer(name = 'consumidor'): { plugin: PluginDefinition; get: () => MetricsService } {
  let service: MetricsService | undefined;
  const plugin = definePlugin({
    name,
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

// Memória que o `stop()` não fecha, para o teste ler e gravar depois. Com `hold`, o `increment`
// da coleção `hourly` avisa `held` e espera `until`, segurando o flush no meio.
function testStorage(hold?: { until: Promise<void>; held: () => void }): StoragePort {
  const real = createMemoryStorage();
  const wrap = <T extends object>(target: T, override: (key: string | symbol) => unknown): T =>
    new Proxy(target, {
      get(t, key) {
        const replaced = override(key);
        if (replaced !== undefined) return replaced;
        const value: unknown = Reflect.get(t, key, t);
        return typeof value === 'function' ? value.bind(t) : value;
      },
    });
  return wrap(real, (key) => {
    if (key === 'close') return async () => undefined;
    if (key !== 'forNamespace' || !hold) return undefined;
    return (namespace: string) => {
      const ns = real.forNamespace(namespace);
      return wrap(ns, (k) => {
        if (k !== 'collection') return undefined;
        return (name: string, options?: CollectionOptions) => {
          const c = ns.collection(name, options);
          return wrap(c, (method) =>
            name === 'hourly' && method === 'increment'
              ? async (...args: Parameters<typeof c.increment>) => {
                  hold.held();
                  await hold.until;
                  return c.increment(...args);
                }
              : undefined,
          );
        };
      });
    };
  });
}

const coll = (storage: StoragePort, name: string) =>
  storage.forNamespace('metrics').collection<HistoryDoc>(name);

const FAST = { metrics: { flushIntervalMs: 1000 } };
const flush = () => vi.advanceTimersByTimeAsync(1000);
const DAY = { from: '2026-10-17', to: '2026-10-17', granularity: 'day' } as const;

async function setup(config: Record<string, unknown> = {}, storage = testStorage()) {
  const { plugin, get } = consumer();
  const bot = await createTestBot({
    plugins: [metrics, plugin],
    storage,
    pluginConfig: { metrics: { flushIntervalMs: 1000, ...config } },
  });
  return { storage, bot, m: get() };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-17T12:30:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('query: contador', () => {
  it('soma o gravado com o delta da registry sem duplicar', async () => {
    const { bot, m } = await setup();
    const x = m.counter({ name: 'app_x_total', help: 'x', labelNames: ['k'] });
    const total = async (q: Partial<MetricQuery> = {}) =>
      m.query({ name: 'app_x_total', ...DAY, groupBy: [], ...q });

    x.inc({ k: 'a' }, 3);
    expect(await total()).toEqual([
      { type: 'counter', period: '2026-10-17', labels: {}, value: 3 },
    ]);
    await flush();
    x.inc({ k: 'a' }, 4);
    expect((await total())[0]).toMatchObject({ value: 7 });
    await flush();
    expect((await total())[0]).toMatchObject({ value: 7 });
    expect(
      await total({ from: '2026-10-17T12', to: '2026-10-17T12', granularity: 'hour' }),
    ).toEqual([{ type: 'counter', period: '2026-10-17T12', labels: {}, value: 7 }]);
    await bot.stop();
  });

  it('where filtra; groupBy [] soma tudo, por rótulo agrupa, ausente dá uma linha por série', async () => {
    const { bot, m } = await setup();
    const x = m.counter({ name: 'app_x_total', help: 'x', labelNames: ['route', 'status'] });
    x.inc({ route: 'a', status: 'ok' }, 1);
    x.inc({ route: 'a', status: 'erro' }, 2);
    x.inc({ route: 'b', status: 'ok' }, 4);
    x.inc({ status: 'ok' }, 8); // sem `route`
    await flush();
    const q = (rest: Partial<MetricQuery>) => m.query({ name: 'app_x_total', ...DAY, ...rest });
    const values = async (rest: Partial<MetricQuery>) =>
      (await q(rest)).map((r) => [r.labels, r.type === 'counter' ? r.value : NaN]);

    expect(await values({ groupBy: [] })).toEqual([[{}, 15]]);
    expect(await values({ groupBy: ['route'] })).toEqual([
      [{ route: 'a' }, 3],
      [{ route: 'b' }, 4],
      [{}, 8],
    ]);
    expect(await values({ where: { status: 'ok' }, groupBy: ['route'] })).toEqual([
      [{ route: 'a' }, 1],
      [{ route: 'b' }, 4],
      [{}, 8],
    ]);
    expect(await values({})).toEqual([
      [{ route: 'a', status: 'erro' }, 2],
      [{ route: 'a', status: 'ok' }, 1],
      [{ route: 'b', status: 'ok' }, 4],
      [{ status: 'ok' }, 8],
    ]);
    expect(await q({ where: { route: 'z' } })).toEqual([]);
    expect(await m.query({ name: 'nao_existe', ...DAY })).toEqual([]);
    await bot.stop();
  });

  it('separa por hora e dia, com o dia no formato de hora valendo de 00 a 23', async () => {
    const { bot, m } = await setup();
    const x = m.counter({ name: 'app_x_total', help: 'x', labelNames: [] });
    x.inc({}, 1);
    await flush();
    vi.setSystemTime(new Date('2026-10-17T14:10:00Z'));
    x.inc({}, 2);
    await flush();
    vi.setSystemTime(new Date('2026-10-18T09:00:00Z'));
    x.inc({}, 4); // só na registry

    const hours = await m.query({
      name: 'app_x_total',
      from: '2026-10-17',
      to: '2026-10-18',
      granularity: 'hour',
    });
    expect(hours.map((r) => [r.period, r.type === 'counter' && r.value])).toEqual([
      ['2026-10-17T12', 1],
      ['2026-10-17T14', 2],
      ['2026-10-18T09', 4],
    ]);
    const days = await m.query({
      name: 'app_x_total',
      from: '2026-10-17',
      to: '2026-10-18',
      granularity: 'day',
    });
    expect(days.map((r) => [r.period, r.type === 'counter' && r.value])).toEqual([
      ['2026-10-17', 3],
      ['2026-10-18', 4],
    ]);
    await bot.stop();
  });

  it('o período corrente segue o timeZone da config', async () => {
    vi.setSystemTime(new Date('2026-10-17T02:30:00Z')); // 23:30 do dia 16 em São Paulo
    const { bot, m } = await setup({ timeZone: 'America/Sao_Paulo' });
    m.counter({ name: 'app_x_total', help: 'x', labelNames: [] }).inc({}, 5);
    const q = (from: string, granularity: 'hour' | 'day') =>
      m.query({ name: 'app_x_total', from, to: from, granularity, groupBy: [] });

    expect(await q('2026-10-16', 'day')).toEqual([
      { type: 'counter', period: '2026-10-16', labels: {}, value: 5 },
    ]);
    expect(await q('2026-10-17', 'day')).toEqual([]);
    expect((await q('2026-10-16T23', 'hour'))[0]).toMatchObject({ value: 5 });
    await bot.stop();
  });

  it('intervalo inválido ou fora da retenção lança TypeError', async () => {
    const { bot, m } = await setup({ retention: { hourDays: 7, dayDays: 30 } });
    const q = (rest: Partial<MetricQuery>) => m.query({ name: 'app_x_total', ...DAY, ...rest });

    await expect(q({ from: '2026-10-18' })).rejects.toThrow(TypeError); // from > to
    await expect(q({ from: '17/10/2026' })).rejects.toThrow(TypeError);
    await expect(q({ from: '2026-02-30', to: '2026-03-01' })).rejects.toThrow(TypeError);
    await expect(q({ from: '2026-10-17T12' })).rejects.toThrow(TypeError); // hora no dia
    await expect(q({ granularity: 'hour', from: '2026-10-17T24' })).rejects.toThrow(TypeError);
    await expect(q({ granularity: 'week' as 'day' })).rejects.toThrow(TypeError);
    await expect(q({ from: '2026-09-01' })).rejects.toThrow(/retenção/);
    await expect(q({ granularity: 'hour', from: '2026-10-09' })).rejects.toThrow(/retenção/);
    // No limite da retenção ainda vale.
    await expect(q({ granularity: 'hour', from: '2026-10-10' })).resolves.toEqual([]);
    await bot.stop();
  });
});

describe('query: histograma', () => {
  it('soma baldes e interpola o percentil dentro do balde', async () => {
    const { bot, m } = await setup();
    const h = m.histogram({
      name: 'app_lat_seconds',
      help: 'h',
      labelNames: ['route'],
      buckets: [0.1, 1],
    });
    h.observe({ route: 'a' }, 0.05);
    h.observe({ route: 'a' }, 0.5);
    await flush();
    h.observe({ route: 'b' }, 0.7);
    h.observe({ route: 'b' }, 5);

    const [row] = await m.query({ name: 'app_lat_seconds', ...DAY, groupBy: [] });
    expect(row).toMatchObject({
      type: 'histogram',
      count: 4,
      buckets: [
        { le: 0.1, count: 1 },
        { le: 1, count: 2 },
        { le: Number.POSITIVE_INFINITY, count: 1 },
      ],
    });
    if (row?.type !== 'histogram') throw new Error('esperava histograma');
    expect(row.sum).toBeCloseTo(6.25);
    // p50: rank 2, no balde (0.1, 1] com 1 abaixo: 0.1 + 0.9 × (1/2).
    expect(row.p50).toBeCloseTo(0.55);
    // p95 e p99 caem no +Inf: o maior limite finito.
    expect(row.p95).toBe(1);
    expect(row.p99).toBe(1);
    await bot.stop();
  });

  it('balde vazio não gravado ainda conta como limite inferior', async () => {
    const { bot, m } = await setup();
    const h = m.histogram({
      name: 'app_lat_seconds',
      help: 'h',
      labelNames: [],
      buckets: [1, 2, 5],
    });
    h.observe({}, 3);
    h.observe({}, 4);
    await flush();

    const [row] = await m.query({ name: 'app_lat_seconds', ...DAY });
    // Só `le:5` foi gravado; o limite inferior 2 vem da declaração: 2 + 3 × (1/2).
    expect(row).toMatchObject({ p50: 3.5 });
    await bot.stop();
  });

  it('limites diferentes entre dias: a união dos limites', async () => {
    const { storage, bot, m } = await setup();
    m.histogram({ name: 'app_lat_seconds', help: 'h', labelNames: [], buckets: [1, 10] });
    // Dia gravado por uma declaração anterior, com os limites [2, 10].
    const doc = { metric: 'app_lat_seconds', period: '2026-10-16', key: '[]', labels: {} };
    for (const [field, value] of [
      ['le:2', 4],
      ['le:10', 4],
      ['count', 8],
      ['sum', 30],
    ] as const) {
      await coll(storage, 'daily').insert({ ...doc, field, value });
    }

    const [row] = await m.query({
      name: 'app_lat_seconds',
      from: '2026-10-16',
      to: '2026-10-16',
      granularity: 'day',
    });
    expect(row).toMatchObject({
      buckets: [
        { le: 1, count: 0 },
        { le: 2, count: 4 },
        { le: 10, count: 4 },
        { le: Number.POSITIVE_INFINITY, count: 0 },
      ],
    });
    if (row?.type !== 'histogram') throw new Error('esperava histograma');
    expect(row.p50).toBeCloseTo(2); // rank 4: 1 + 1 × (4/4)
    expect(row.p95).toBeCloseTo(9.2); // rank 7,6: 2 + 8 × (3,6/4)
    expect(row.p99).toBeCloseTo(9.84); // rank 7,92: 2 + 8 × (3,92/4)
    await bot.stop();
  });

  it('quantile: tudo no +Inf vale o maior finito; sem contagem vale 0', () => {
    const inf = Number.POSITIVE_INFINITY;
    expect(
      quantile(0.5, [
        { le: 1, count: 0 },
        { le: inf, count: 3 },
      ]),
    ).toBe(1);
    expect(quantile(0.5, [{ le: inf, count: 0 }])).toBe(0);
    // Primeiro balde interpola a partir de 0.
    expect(
      quantile(0.25, [
        { le: 4, count: 4 },
        { le: inf, count: 0 },
      ]),
    ).toBe(1);
  });
});

describe('query: gauge', () => {
  it('agrupado: max dos máximos e last da série amostrada mais recentemente', async () => {
    const { bot, m } = await setup();
    const g = m.gauge({ name: 'app_fila', help: 'g', labelNames: ['k'] });
    const q = () => m.query({ name: 'app_fila', ...DAY, groupBy: [] });

    g.set({ k: 'a' }, 5);
    g.set({ k: 'a' }, 2);
    await flush();
    g.set({ k: 'b' }, 1);
    await flush(); // gravado depois do "a"
    expect(await q()).toEqual([
      { type: 'gauge', period: '2026-10-17', labels: {}, last: 1, max: 5 },
    ]);

    g.set({ k: 'a' }, 3); // só na registry: a amostra mais nova
    expect(await q()).toEqual([
      { type: 'gauge', period: '2026-10-17', labels: {}, last: 3, max: 5 },
    ]);
    expect(await m.query({ name: 'app_fila', ...DAY })).toEqual([
      { type: 'gauge', period: '2026-10-17', labels: { k: 'a' }, last: 3, max: 5 },
      { type: 'gauge', period: '2026-10-17', labels: { k: 'b' }, last: 1, max: 1 },
    ]);
    await bot.stop();
  });
});

describe('query: concorrência', () => {
  it('query durante o flush não conta em dobro nem perde', async () => {
    const release = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const storage = testStorage({ until: release.promise, held: held.resolve });
    const { bot, m } = await setup({}, storage);
    const x = m.counter({ name: 'app_x_total', help: 'x', labelNames: [] });
    const value = async () =>
      (await m.query({ name: 'app_x_total', ...DAY, groupBy: [] }))
        .map((r) => (r.type === 'counter' ? r.value : NaN))
        .at(0);

    x.inc({}, 3);
    const before = value(); // entra na fila antes do flush
    const flushing = flush();
    // O flush já tirou o delta da registry e está preso na gravação da hora.
    await held.promise;
    const during = value();
    x.inc({}, 1);
    release.resolve();
    await flushing;
    expect([await before, await during, await value()]).toEqual([3, 4, 4]);
    await bot.stop();
  });
});

describe('catalog', () => {
  it('junta as declarações vivas com as do histórico, por nome', async () => {
    const storage = testStorage();
    const consumidor = consumer();
    const outro = consumer('outro');
    const bot = await createTestBot({
      plugins: [metrics, consumidor.plugin, outro.plugin],
      storage,
      pluginConfig: FAST,
    });
    const spec = { name: 'app_x_total', help: 'x', labelNames: ['k'] };
    outro.get().counter(spec);
    consumidor.get().counter(spec); // segundo a declarar: vira o dono quando "outro" sai
    outro.get().histogram({ name: 'app_lat_seconds', help: 'h', labelNames: [] });
    await bot.bot.plugins.disable('outro');

    const all = await consumidor.get().catalog();
    const names = all.map((d) => d.name);
    expect(names).toEqual([...names].sort());
    const byName = Object.fromEntries(all.map((d) => [d.name, d]));
    expect(byName['app_x_total']).toEqual({
      name: 'app_x_total',
      type: 'counter',
      help: 'x',
      labelNames: ['k'],
      owner: 'consumidor',
      live: true,
    });
    // Só no histórico: sem dono, com os limites que usava (o padrão do prom-client).
    expect(byName['app_lat_seconds']).toEqual({
      name: 'app_lat_seconds',
      type: 'histogram',
      help: 'h',
      labelNames: [],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      live: false,
    });
    expect(byName['bridger_messages_handled_total']).toMatchObject({ owner: 'core', live: true });
    expect(byName['bridger_active_users']).toMatchObject({ owner: 'core', live: true });
    await bot.stop();
  });
});
