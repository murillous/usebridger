import { describe, expect, it } from 'vitest';
import { byLabel, daysBetween, percentile, perDay, summarize, total } from './metrics.ts';
import type { MetricRowView, MetricsResponse } from './types.ts';

const counter = (day: string, value: number, labels = {}): MetricRowView => ({
  type: 'counter',
  day,
  labels,
  value,
});
// 3 observações no balde de 5 ms e 1 no de 100 ms (índices 0 e 4 de 13).
const hist = (buckets: Record<number, number>): MetricRowView => {
  const b = Array.from({ length: 13 }, (_, i) => buckets[i] ?? 0);
  return {
    type: 'histogram',
    day: '2026-10-17',
    labels: {},
    count: b.reduce((a, n) => a + n, 0),
    sum: 0,
    buckets: b,
  };
};

describe('métricas do dashboard', () => {
  it('agrupa por rótulo e por dia, com dia sem dado em zero', () => {
    const rows = [
      counter('2026-10-16', 2, { status: 'ok' }),
      counter('2026-10-17', 1, { status: 'ok' }),
      counter('2026-10-17', 5, { status: 'error' }),
    ];
    expect(byLabel(rows, 'status')).toEqual([
      { key: 'error', value: 5 },
      { key: 'ok', value: 3 },
    ]);
    expect(perDay(rows, daysBetween('2026-10-15', '2026-10-17'))).toEqual([
      { day: '2026-10-15', value: 0 },
      { day: '2026-10-16', value: 2 },
      { day: '2026-10-17', value: 6 },
    ]);
    expect(total(rows)).toBe(8);
  });

  it('calcula percentil pelos baldes somados', () => {
    const rows = [hist({ 0: 3 }), hist({ 4: 1 })];
    expect(percentile(rows, 0.5)).toBe(5);
    expect(percentile(rows, 0.95)).toBe(100);
    expect(percentile([], 0.5)).toBeUndefined();
  });

  it('resume toda métrica do período, inclusive a de um plugin qualquer', () => {
    const data: MetricsResponse = {
      available: true,
      from: '2026-10-17',
      to: '2026-10-17',
      metrics: [
        {
          name: 'plugin.novo',
          rows: [counter('2026-10-17', 4, { a: '1' }), counter('2026-10-17', 1, { a: '2' })],
        },
        { name: 'vazia', rows: [] },
        { name: 'lat', rows: [hist({ 4: 2 })] },
      ],
    };
    expect(summarize(data)).toEqual([
      { name: 'plugin.novo', type: 'counter', series: 2, total: 5 },
      { name: 'lat', type: 'histogram', series: 1, total: 2, p95: 100 },
    ]);
    expect(summarize({ available: false })).toEqual([]);
  });
});
