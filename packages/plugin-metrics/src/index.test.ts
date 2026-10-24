import { definePlugin, type Logger, type PluginDefinition } from '@usebridger/core';
import { createTestBot } from '@usebridger/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HISTOGRAM_BUCKETS,
  type HistogramRow,
  type MetricsExporter,
  type MetricsService,
  metrics,
} from './index.ts';

const DAY = '2026-10-17';

function fakeLog(): { log: Logger; calls: { level: string; message: string }[] } {
  const calls: { level: string; message: string }[] = [];
  const mk = (): Logger => {
    const fn = (level: string) => (message: string) => calls.push({ level, message });
    return {
      level: 'info',
      trace: fn('trace'),
      debug: fn('debug'),
      info: fn('info'),
      warn: fn('warn'),
      error: fn('error'),
      fatal: fn('fatal'),
      event: (event) => fn(event.level)(event.message),
      child: mk,
    };
  };
  return { log: mk(), calls };
}

// Plugin consumidor: pega o serviço e contribui com um exportador, como um app faria.
function setup(exporters: MetricsExporter[] = []): {
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

const range = { from: DAY, to: DAY };

beforeEach(() => {
  // Só relógio e intervalo: o resto (promises do storage) segue real.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date(`${DAY}T12:00:00Z`));
});
afterEach(() => vi.useRealTimers());

describe('counter e query', () => {
  it('soma em memória e a consulta enxerga antes do flush', async () => {
    const { plugin, get } = setup();
    const bot = await createTestBot({ plugins: [metrics, plugin] });

    get().counter('ai.tokens', { model: 'a', kind: 'input' }, 10);
    get().counter('ai.tokens', { kind: 'input', model: 'a' }, 5);
    get().counter('ai.tokens', { model: 'b', kind: 'input' });

    const rows = await get().query('ai.tokens', range);
    expect(rows).toEqual([
      {
        metric: 'ai.tokens',
        type: 'counter',
        day: DAY,
        labels: { model: 'a', kind: 'input' },
        value: 15,
      },
      {
        metric: 'ai.tokens',
        type: 'counter',
        day: DAY,
        labels: { model: 'b', kind: 'input' },
        value: 1,
      },
    ]);
    await bot.stop();
  });

  it('metrica sem dados e consulta fora do intervalo voltam vazias', async () => {
    const { plugin, get } = setup();
    const bot = await createTestBot({ plugins: [metrics, plugin] });
    get().counter('x', {});

    expect(await get().query('nada', range)).toEqual([]);
    expect(await get().query('x', { from: '2026-01-01', to: '2026-01-02' })).toEqual([]);
    await expect(get().query('x', { from: 'ontem', to: DAY })).rejects.toThrow(TypeError);
    await bot.stop();
  });

  it('valor invalido e mistura de tipos lancam TypeError', async () => {
    const { plugin, get } = setup();
    const bot = await createTestBot({ plugins: [metrics, plugin] });

    expect(() => get().counter('x', {}, -1)).toThrow(TypeError);
    expect(() => get().observe('h', {}, Number.NaN)).toThrow(TypeError);
    get().counter('x', {});
    expect(() => get().observe('x', {}, 1)).toThrow(TypeError);
    await bot.stop();
  });
});

describe('histograma', () => {
  it('calcula p50/p95/p99 pelos baldes e soma count/sum', async () => {
    const { plugin, get } = setup();
    const bot = await createTestBot({ plugins: [metrics, plugin] });

    for (let i = 0; i < 90; i++) get().observe('lat', { ok: 'true' }, 8); // balde 10
    for (let i = 0; i < 9; i++) get().observe('lat', { ok: 'true' }, 400); // balde 500
    get().observe('lat', { ok: 'true' }, 60_000); // acima de 30 s: +Inf

    const [row] = (await get().query('lat', range)) as HistogramRow[];
    expect(row).toMatchObject({
      count: 100,
      sum: 720 + 3600 + 60_000,
      p50: 10,
      p95: 500,
      p99: 500,
    });
    expect(row?.buckets).toHaveLength(HISTOGRAM_BUCKETS.length + 1);
    expect(row?.buckets.at(-1)).toBe(1);
    await bot.stop();
  });

  it('limites vao de 5 ms a 30 s', () => {
    expect(HISTOGRAM_BUCKETS[0]).toBe(5);
    expect(HISTOGRAM_BUCKETS.at(-1)).toBe(30_000);
  });
});

describe('rotulos pessoais', () => {
  it.each([
    '5511999999999@s.whatsapp.net',
    '1203630@g.us',
    'abc@lid',
    '+5511999999999',
    '123456789',
  ])('rejeita %s com TypeError', async (value) => {
    const { plugin, get } = setup();
    const bot = await createTestBot({ plugins: [metrics, plugin] });

    expect(() => get().counter('x', { chat: value })).toThrow(TypeError);
    expect(() => get().observe('h', { user: value }, 1)).toThrow(TypeError);
    expect(await get().query('x', range)).toEqual([]);
    await bot.stop();
  });

  it('aceita rotulos comuns', async () => {
    const { plugin, get } = setup();
    const bot = await createTestBot({ plugins: [metrics, plugin] });
    expect(() => get().counter('x', { model: 'gpt-4o', ok: 'true', n: '42' })).not.toThrow();
    await bot.stop();
  });
});

describe('limite de series', () => {
  it('descarta serie nova acima do limite, avisa uma vez e mantem as existentes', async () => {
    const { plugin, get } = setup();
    const { log, calls } = fakeLog();
    const bot = await createTestBot({
      plugins: [metrics, plugin],
      logger: log,
      pluginConfig: { metrics: { maxSeriesPerMetric: 2 } },
    });

    get().counter('x', { m: 'a' });
    get().counter('x', { m: 'b' });
    get().counter('x', { m: 'c' });
    get().counter('x', { m: 'd' });
    get().counter('x', { m: 'a' });

    const rows = await get().query('x', range);
    expect(rows.map((r) => r.labels['m'])).toEqual(['a', 'b']);
    expect(rows[0]).toMatchObject({ value: 2 });
    expect(calls.filter((c) => c.level === 'warn')).toHaveLength(1);
    await bot.stop();
  });
});

describe('flush', () => {
  it('periodico persiste sem duplicar e a consulta soma persistido e memoria', async () => {
    const { plugin, get } = setup();
    const bot = await createTestBot({
      plugins: [metrics, plugin],
      pluginConfig: { metrics: { flushIntervalMs: 1000 } },
    });

    get().counter('x', { m: 'a' }, 3);
    await vi.advanceTimersByTimeAsync(1000);
    get().counter('x', { m: 'a' }, 4);

    const [row] = await get().query('x', range);
    expect(row).toMatchObject({ value: 7 });
    await bot.stop();
  });

  it('final no stop grava o que sobrou e sobrevive ao restart', async () => {
    const { plugin, get } = setup();
    const bot = await createTestBot({ plugins: [metrics, plugin] });
    get().counter('x', { m: 'a' }, 9);
    get().observe('h', {}, 20);

    const bot2 = await bot.restart();
    const [x] = await get().query('x', range);
    const [h] = (await get().query('h', range)) as HistogramRow[];

    expect(x).toMatchObject({ value: 9 });
    expect(h).toMatchObject({ count: 1, sum: 20, p50: 25 });
    await bot2.stop();
  });

  it('para o intervalo no stop', async () => {
    const { plugin } = setup();
    const bot = await createTestBot({ plugins: [metrics, plugin] });
    await bot.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('metrics.exporters', () => {
  it('entrega o snapshot do flush a cada exportador; erro de um vai pro log e nao derruba', async () => {
    const seen: unknown[] = [];
    const ruim: MetricsExporter = () => {
      throw new Error('boom');
    };
    const bom: MetricsExporter = (s) => {
      seen.push(s);
    };
    const { plugin, get } = setup([ruim, bom]);
    const { log, calls } = fakeLog();
    const bot = await createTestBot({
      plugins: [metrics, plugin],
      logger: log,
      pluginConfig: { metrics: { flushIntervalMs: 1000 } },
    });

    get().counter('x', { m: 'a' }, 2);
    await vi.advanceTimersByTimeAsync(1000);

    expect(seen).toEqual([
      {
        at: expect.any(String),
        rows: [{ metric: 'x', type: 'counter', day: DAY, labels: { m: 'a' }, value: 2 }],
      },
    ]);
    expect(calls.some((c) => c.level === 'error')).toBe(true);
    // Flush sem novidade não chama exportador.
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toHaveLength(1);
    await bot.stop();
  });
});

describe('retencao', () => {
  it('apaga dias mais antigos que retentionDays no flush', async () => {
    const { plugin, get } = setup();
    const bot = await createTestBot({
      plugins: [metrics, plugin],
      pluginConfig: { metrics: { flushIntervalMs: 1000, retentionDays: 2 } },
    });

    get().counter('x', {}, 1); // 2026-10-17
    await vi.advanceTimersByTimeAsync(1000);
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    get().counter('x', {}, 1); // 2026-10-20
    await vi.advanceTimersByTimeAsync(1000); // corte: 2026-10-18

    const rows = await get().query('x', { from: '2026-10-01', to: '2026-10-31' });
    expect(rows.map((r) => r.day)).toEqual(['2026-10-20']);
    await bot.stop();
  });
});
