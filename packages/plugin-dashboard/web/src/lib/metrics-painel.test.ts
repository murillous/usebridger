import { describe, expect, it } from 'vitest';
import { catalog, labelNames, percentilePerDay, shortDay } from './metrics.ts';
import type { MetricRowView, MetricsResponse } from './types.ts';

const counter = (day: string, value: number, labels = {}): MetricRowView => ({
  type: 'counter',
  day,
  labels,
  value,
});
const hist = (day: string, bucket: number): MetricRowView => ({
  type: 'histogram',
  day,
  labels: { route: 'ping' },
  count: 2,
  sum: 0,
  buckets: Array.from({ length: 13 }, (_, i) => (i === bucket ? 2 : 0)),
});

describe('painéis de métricas (paridade com o canvas)', () => {
  it('rotula o eixo com "hoje" no último dia e "12 out" nos demais', () => {
    expect(shortDay('2026-10-18', '2026-10-18')).toBe('hoje');
    expect(shortDay('2026-10-12', '2026-10-18')).toBe('12 out');
  });

  it('percentil por dia: dia sem observação em zero e balde +Inf limitado ao maior teto', () => {
    const rows = [hist('2026-10-17', 4), hist('2026-10-18', 12)];
    expect(percentilePerDay(rows, ['2026-10-16', '2026-10-17', '2026-10-18'], 0.95)).toEqual([
      { day: '2026-10-16', value: 0 },
      { day: '2026-10-17', value: 100 },
      { day: '2026-10-18', value: 30_000 },
    ]);
  });

  it('lista os rótulos sem repetir, em ordem alfabética', () => {
    const rows = [counter('2026-10-18', 1, { status: 'ok' }), counter('2026-10-18', 1, { a: 'x' })];
    expect(labelNames(rows)).toEqual(['a', 'status']);
    expect(labelNames([])).toEqual([]);
  });

  it('catálogo traz rótulos e o valor de hoje (último dia do intervalo)', () => {
    const data: MetricsResponse = {
      available: true,
      from: '2026-10-17',
      to: '2026-10-18',
      metrics: [
        {
          name: 'x.total',
          rows: [counter('2026-10-17', 5, { k: 'a' }), counter('2026-10-18', 2, { k: 'a' })],
        },
        { name: 'x.lat', rows: [hist('2026-10-17', 4), hist('2026-10-18', 0)] },
      ],
    };
    expect(catalog(data)).toEqual([
      { name: 'x.total', type: 'counter', series: 1, total: 7, labels: ['k'], today: 2 },
      {
        name: 'x.lat',
        type: 'histogram',
        series: 1,
        total: 4,
        p95: 100,
        labels: ['route'],
        today: 2,
        todayP95: 5,
      },
    ]);
    expect(catalog({ available: false })).toEqual([]);
  });
});
