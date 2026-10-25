import type { LogFields, Logger } from '@usebridger/core';
import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';
import { createMetrics } from './service.ts';

function recordingLog(): { log: Logger; lines: { event: string; fields?: LogFields }[] } {
  const lines: { event: string; fields?: LogFields }[] = [];
  const log: Logger = {
    level: 'info',
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    event: (event, fields) => void lines.push({ event: event.name, ...(fields && { fields }) }),
    child: () => log,
  };
  return { log, lines };
}

function setup(maxSeriesPerMetric = 100) {
  const registry = new Registry();
  const { log, lines } = recordingLog();
  const runtime = createMetrics({ registry, log, maxSeriesPerMetric });
  return { registry, runtime, lines, m: runtime.scoped('ai') };
}

describe('declaração', () => {
  it('aceita contador, histograma e gauge válidos e expõe HELP/TYPE', async () => {
    const { registry, m } = setup();
    m.counter({ name: 'ai_tokens_total', help: 'Tokens', labelNames: ['model'] }).inc(
      { model: 'x' },
      3,
    );
    m.histogram({
      name: 'ai_latency_seconds',
      help: 'Latência',
      labelNames: [],
      buckets: [0.1, 1],
    }).observe({}, 0.5);
    m.gauge({ name: 'ai:queue', help: 'Fila', labelNames: ['kind'] }).set({ kind: 'a' }, 2);
    const text = await registry.metrics();
    expect(text).toContain('# HELP ai_tokens_total Tokens\n# TYPE ai_tokens_total counter');
    expect(text).toContain('ai_tokens_total{model="x"} 3');
    expect(text).toContain('ai_latency_seconds_bucket{le="1"} 1');
    expect(text).toContain('ai_latency_seconds_bucket{le="+Inf"} 1');
    expect(text).toContain('ai:queue{kind="a"} 2');
  });

  it('sem buckets vale o padrão do prom-client', async () => {
    const { registry, m } = setup();
    m.histogram({ name: 'h_seconds', help: 'h', labelNames: [] }).observe({}, 1);
    const text = await registry.metrics();
    expect(text).toContain('h_seconds_bucket{le="0.005"} 0');
    expect(text).toContain('h_seconds_bucket{le="10"} 1');
  });

  it.each([
    ['nome inválido', () => setup().m.gauge({ name: '9x', help: 'h', labelNames: [] })],
    ['nome com ponto', () => setup().m.gauge({ name: 'a.b', help: 'h', labelNames: [] })],
    ['contador sem _total', () => setup().m.counter({ name: 'a', help: 'h', labelNames: [] })],
    ['prefixo process_', () => setup().m.gauge({ name: 'process_x', help: 'h', labelNames: [] })],
    [
      'prefixo nodejs_',
      () => setup().m.counter({ name: 'nodejs_x_total', help: 'h', labelNames: [] }),
    ],
    [
      'prefixo bridger_runtime_',
      () => setup().m.gauge({ name: 'bridger_runtime_rss_bytes', help: 'h', labelNames: [] }),
    ],
    ['help vazio', () => setup().m.gauge({ name: 'a', help: '', labelNames: [] })],
    ['rótulo inválido', () => setup().m.gauge({ name: 'a', help: 'h', labelNames: ['a-b'] })],
    ['rótulo repetido', () => setup().m.gauge({ name: 'a', help: 'h', labelNames: ['x', 'x'] })],
    ['le no histograma', () => setup().m.histogram({ name: 'a', help: 'h', labelNames: ['le'] })],
    [
      'buckets fora de ordem',
      () => setup().m.histogram({ name: 'a', help: 'h', labelNames: [], buckets: [1, 1] }),
    ],
    [
      'bucket infinito',
      () => setup().m.histogram({ name: 'a', help: 'h', labelNames: [], buckets: [1, Infinity] }),
    ],
  ])('recusa %s com TypeError', (_, declare) => {
    expect(declare).toThrow(TypeError);
  });

  it('le fora do histograma é rótulo comum', () => {
    expect(() => setup().m.gauge({ name: 'a', help: 'h', labelNames: ['le'] })).not.toThrow();
  });
});

describe('redeclaração e dono', () => {
  it('a mesma especificação devolve o mesmo handle, também a outro plugin', () => {
    const { runtime, m } = setup();
    const spec = { name: 'x_total', help: 'h', labelNames: ['a'] } as const;
    const first = m.counter(spec);
    expect(m.counter({ ...spec, labelNames: ['a'] })).toBe(first);
    expect(runtime.scoped('outro').counter(spec)).toBe(first);
    expect(runtime.ownerOf('x_total')).toBe('ai');
  });

  it('especificação diferente lança TypeError', () => {
    const { runtime, m } = setup();
    m.histogram({ name: 'h', help: 'h', labelNames: ['a'], buckets: [1] });
    const other = runtime.scoped('outro');
    expect(() =>
      other.histogram({ name: 'h', help: 'outro', labelNames: ['a'], buckets: [1] }),
    ).toThrow(TypeError);
    expect(() =>
      other.histogram({ name: 'h', help: 'h', labelNames: ['b'], buckets: [1] }),
    ).toThrow(TypeError);
    expect(() =>
      other.histogram({ name: 'h', help: 'h', labelNames: ['a'], buckets: [2] }),
    ).toThrow(TypeError);
    expect(() => other.gauge({ name: 'h', help: 'h', labelNames: ['a'] })).toThrow(TypeError);
  });

  it('o kernel é core; o release tira o dono e a métrica volta na próxima declaração', async () => {
    const { registry, runtime, m } = setup();
    runtime.service.gauge({ name: 'k', help: 'k', labelNames: [] });
    expect(runtime.ownerOf('k')).toBe('core');

    m.counter({ name: 'x_total', help: 'h', labelNames: [] }).inc({}, 5);
    runtime.scoped('outro').counter({ name: 'x_total', help: 'h', labelNames: [] });
    runtime.release('ai');
    // Outro declarante segura a métrica e vira o dono.
    expect(runtime.ownerOf('x_total')).toBe('outro');
    expect(await registry.metrics()).toContain('x_total 5');

    runtime.release('outro');
    expect(runtime.ownerOf('x_total')).toBeUndefined();
    expect(await registry.metrics()).not.toContain('x_total');

    runtime.scoped('ai').counter({ name: 'x_total', help: 'h', labelNames: [] }).inc({});
    expect(runtime.ownerOf('x_total')).toBe('ai');
    expect(await registry.metrics()).toContain('x_total 1');
  });
});

describe('guardas no handle', () => {
  it('rótulo com cara de id pessoal lança TypeError', () => {
    const c = setup().m.counter({ name: 'x_total', help: 'h', labelNames: ['who'] });
    for (const v of ['5511999999999@s.whatsapp.net', '+5511999999999', '-1001234567']) {
      expect(() => c.inc({ who: v })).toThrow(TypeError);
    }
    expect(() => c.inc({ who: 'admin' })).not.toThrow();
  });

  it('rótulo não declarado e valor inválido lançam TypeError', () => {
    const { m } = setup();
    const c = m.counter({ name: 'x_total', help: 'h', labelNames: ['a'] });
    // @ts-expect-error: rótulo fora de labelNames não compila
    expect(() => c.inc({ b: 'x' })).toThrow(TypeError);
    expect(() => c.inc({}, -1)).toThrow(TypeError);
    expect(() => c.inc({}, Number.NaN)).toThrow(TypeError);
    const g = m.gauge({ name: 'g', help: 'h', labelNames: [] });
    expect(() => g.set({}, -1)).toThrow(TypeError);
    expect(() => g.set({}, Infinity)).toThrow(TypeError);
  });

  it('rótulo declarado pode faltar: fica ausente na série', async () => {
    const { registry, m } = setup();
    const c = m.counter({ name: 'x_total', help: 'h', labelNames: ['a', 'b'] });
    c.inc({ a: '1' });
    c.inc({ a: '1', b: '2' });
    c.inc({ b: '2', a: '1' }); // a ordem das chaves não cria série nova
    const text = await registry.metrics();
    expect(text).toContain('x_total{a="1"} 1');
    expect(text).toContain('x_total{a="1",b="2"} 2');
  });

  it('série acima do limite é descartada com um warn só por métrica', async () => {
    const { registry, lines, m } = setup(2);
    const c = m.counter({ name: 'x_total', help: 'h', labelNames: ['a'] });
    c.inc({ a: '1' });
    c.inc({ a: '2' });
    c.inc({ a: '3' });
    c.inc({ a: '4' });
    c.inc({ a: '1' }); // série existente segue somando
    const text = await registry.metrics();
    expect(text).toContain('x_total{a="1"} 2');
    expect(text).not.toContain('a="3"');
    expect(lines.filter((l) => l.event === 'metrics.series.overflow')).toEqual([
      { event: 'metrics.series.overflow', fields: { metric: 'x_total', maxSeriesPerMetric: 2 } },
    ]);
  });
});
