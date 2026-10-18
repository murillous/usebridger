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

describe('names', () => {
  it('lista métricas do intervalo, do disco e da memória, em ordem', async () => {
    const { runtime } = make(() => []);
    runtime.service.counter('b.disco', {});
    await runtime.flush();
    runtime.service.observe('a.memoria', {}, 10);
    expect(await runtime.service.names(range)).toEqual(['a.memoria', 'b.disco']);
    expect(await runtime.service.names({ from: '2026-01-01', to: '2026-01-02' })).toEqual([]);
  });

  it('recusa intervalo mal formado', async () => {
    const { runtime } = make(() => []);
    await expect(runtime.service.names({ from: 'x', to: range.to })).rejects.toThrow(TypeError);
  });
});

describe('gauge', () => {
  it('guarda o último valor e o máximo do dia, em memória e depois do flush', async () => {
    const { runtime } = make(() => []);
    const g = runtime.service;
    g.gauge('fila', {}, 3);
    g.gauge('fila', {}, 9);
    g.gauge('fila', {}, 2);
    expect(await g.query('fila', range)).toMatchObject([{ type: 'gauge', last: 2, max: 9 }]);
    await runtime.flush();
    g.gauge('fila', {}, 4);
    expect(await g.query('fila', range)).toMatchObject([{ type: 'gauge', last: 4, max: 9 }]);
    await runtime.flush();
    expect(await g.query('fila', range)).toMatchObject([{ type: 'gauge', last: 4, max: 9 }]);
    expect(runtime.totals()).toMatchObject([{ type: 'gauge', last: 4 }]);
  });

  it('rejeita valor negativo e mistura de tipos', () => {
    const { runtime } = make(() => []);
    expect(() => runtime.service.gauge('fila', {}, -1)).toThrow(TypeError);
    runtime.service.counter('c', {});
    expect(() => runtime.service.gauge('c', {}, 1)).toThrow(TypeError);
  });
});

describe('dono da métrica', () => {
  it('grava o caller na primeira escrita, core no serviço do plugin, e limpa no release', () => {
    const { runtime } = make(() => []);
    runtime.scoped('lembretes').counter('lembretes.x', {});
    runtime.scoped('outro').counter('lembretes.x', {});
    runtime.service.counter('bridger.y', {});
    expect(runtime.service.ownerOf('lembretes.x')).toBe('lembretes');
    expect(runtime.service.ownerOf('bridger.y')).toBe('core');
    runtime.release('lembretes');
    expect(runtime.service.ownerOf('lembretes.x')).toBeUndefined();
    expect(runtime.service.ownerOf('bridger.y')).toBe('core');
  });

  it('escrita inválida não vira dono', () => {
    const { runtime } = make(() => []);
    expect(() => runtime.scoped('p').counter('m', {}, -1)).toThrow(TypeError);
    expect(runtime.service.ownerOf('m')).toBeUndefined();
  });
});

describe('gauge nos exportadores e no acumulado', () => {
  it('gauge de outro plugin chega ao exportador e ao totals; a fila de saída fica de fora', async () => {
    const snaps: MetricsSnapshot[] = [];
    const { runtime } = make(() => [(s) => void snaps.push(s)]);
    runtime.scoped('lembretes').gauge('lembretes.fila', {}, 4);
    runtime.service.gauge('bridger.outbound.pending', {}, 7);
    expect(runtime.totals()).toMatchObject([{ metric: 'lembretes.fila', type: 'gauge', last: 4 }]);
    await runtime.flush();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.rows).toMatchObject([{ metric: 'lembretes.fila', type: 'gauge', max: 4 }]);
    // Segue consultável pelo serviço, só não vai a exportador nem ao scrape.
    expect(await runtime.service.query('bridger.outbound.pending', range)).toMatchObject([
      { type: 'gauge', max: 7 },
    ]);
  });
});
