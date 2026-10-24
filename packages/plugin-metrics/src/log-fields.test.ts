import { createMemoryStorage, type LogFields, type Logger } from '@usebridger/core';
import { describe, expect, it, vi } from 'vitest';
import { createMetrics, type MetricDoc } from './service.ts';

// Guarda os campos de cada evento para provar o nome da chave do erro.
function recordingLog(): {
  log: Logger;
  lines: { event: string; fields: LogFields | undefined }[];
} {
  const lines: { event: string; fields: LogFields | undefined }[] = [];
  const log: Logger = {
    level: 'info',
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    event: (event, fields) => void lines.push({ event: event.name, fields }),
    child: () => log,
  };
  return { log, lines };
}

describe('erro nos logs do plugin-metrics', () => {
  it('metrics.write.failed e metrics.exporter.failed levam o erro em err, não em error', async () => {
    const { log, lines } = recordingLog();
    const collection = createMemoryStorage().forNamespace('t').collection<MetricDoc>('daily');
    const boom = new Error('boom');
    const runtime = createMetrics({
      collection,
      log,
      exporters: () => [
        () => {
          throw boom;
        },
      ],
      maxSeriesPerMetric: 10,
      retentionDays: 90,
      now: () => Date.parse('2026-10-17T12:00:00Z'),
    });
    runtime.service.counter('x', {}, 1);
    vi.spyOn(collection, 'increment').mockRejectedValueOnce(boom);
    await runtime.flush();
    // Segundo flush: a gravação volta ao normal e o exportador lança.
    await runtime.flush();
    vi.spyOn(collection, 'find').mockRejectedValueOnce(boom);
    runtime.service.counter('x', {}, 1);
    await runtime.flush();

    const failures = lines.filter((l) =>
      ['metrics.write.failed', 'metrics.exporter.failed'].includes(l.event),
    );
    expect(failures.map((l) => l.event)).toEqual(
      expect.arrayContaining(['metrics.write.failed', 'metrics.exporter.failed']),
    );
    for (const { fields } of failures) {
      expect(fields).toHaveProperty('err', boom);
      expect(fields).not.toHaveProperty('error');
    }
  });
});
