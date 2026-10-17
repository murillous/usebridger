import { createMemoryStorage, type Logger } from '@usebridger/core';
import { describe, expect, it, vi } from 'vitest';
import { createMetrics, type MetricDoc } from './service.ts';
import type { MetricsExporter, MetricsSnapshot } from './types.ts';

const silent: Logger = {
  level: 'info',
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silent,
};

const NOW = Date.parse('2026-10-17T12:00:00Z');
const range = { from: '2026-10-17', to: '2026-10-17' };

function make(exporters: () => readonly MetricsExporter[]) {
  const collection = createMemoryStorage().forNamespace('t').collection<MetricDoc>('daily');
  const runtime = createMetrics({
    collection,
    log: silent,
    exporters,
    maxSeriesPerMetric: 10,
    retentionDays: 90,
    now: () => NOW,
  });
  return { collection, runtime };
}

describe('falhas do flush', () => {
  it('increment que falha volta ao agregado, grava no flush seguinte e não duplica no exportador', async () => {
    const snaps: MetricsSnapshot[] = [];
    const { collection, runtime } = make(() => [(s) => void snaps.push(s)]);
    runtime.service.counter('x', { m: 'a' }, 5);

    const spy = vi.spyOn(collection, 'increment').mockRejectedValueOnce(new Error('disco'));
    await runtime.flush();
    expect(snaps).toEqual([]); // nada gravado, nada exportado
    expect(await runtime.service.query('x', range)).toMatchObject([{ value: 5 }]);

    spy.mockRestore();
    runtime.service.counter('x', { m: 'a' }, 1);
    await runtime.flush();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.rows).toMatchObject([{ value: 6 }]);
    expect(await collection.find({})).toHaveLength(1);

    await runtime.flush();
    expect(snaps).toHaveLength(1);
  });

  it('flush que lança não trava os seguintes nem o query', async () => {
    let boom = true;
    const { runtime } = make(() => {
      if (boom) throw new Error('lista');
      return [];
    });
    runtime.service.counter('x', {}, 2);
    await expect(runtime.flush()).resolves.toBeUndefined();
    boom = false;
    runtime.service.counter('x', {}, 3);
    await runtime.flush();
    expect(await runtime.service.query('x', range)).toMatchObject([{ value: 5 }]);
  });

  it('query que falha rejeita e o seguinte funciona', async () => {
    const { collection, runtime } = make(() => []);
    runtime.service.counter('x', {}, 1);
    vi.spyOn(collection, 'find').mockRejectedValueOnce(new Error('find'));
    await expect(runtime.service.query('x', range)).rejects.toThrow('find');
    await expect(runtime.service.query('x', range)).resolves.toMatchObject([{ value: 1 }]);
  });

  it('query durante o flush não conta em dobro nem perde', async () => {
    const { collection, runtime } = make(() => []);
    runtime.service.counter('x', {}, 4);
    const find = collection.find.bind(collection);
    let first = true;
    vi.spyOn(collection, 'find').mockImplementation(async (q) => {
      const docs = await find(q);
      if (first) {
        first = false;
        await runtime.flush(); // flush periódico caindo no meio do find
      }
      return docs;
    });
    expect(await runtime.service.query('x', range)).toMatchObject([{ value: 4 }]);
  });
});
