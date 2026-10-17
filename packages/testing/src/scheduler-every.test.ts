// Série recorrente do scheduler (ADR 0104) pelo kit: o autor de plugin avança a série com os fake
// timers do Vitest, sem API nova no `TestBot`.

import { definePlugin, type RecurrenceRule } from '@usebridger/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestBot, type TestBot } from './test-bot.ts';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

type Visto = { scheduledAt: number; seriesId: string | undefined };

const bots: TestBot[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const bot of bots.splice(0)) {
    const stopped = bot.stop();
    await vi.runAllTimersAsync();
    await stopped;
  }
  vi.useRealTimers();
});

/** Plugin que guarda o que o handler viu e expõe `every`/`cancel` ao teste. */
function lembrete(rule: RecurrenceRule) {
  const vistos: Visto[] = [];
  let agendar: () => Promise<string> = () => Promise.reject(new Error('setup não rodou'));
  let cancelar: (id: string) => Promise<boolean> = () => Promise.resolve(false);
  const plugin = definePlugin({
    name: 'lembrete',
    version: '1.0.0',
    engine: '>=0.0.0',
    setup(ctx) {
      ctx.scheduler.on('tick', (_payload, job) => {
        vistos.push({ scheduledAt: job.scheduledAt.getTime(), seriesId: job.seriesId });
      });
      agendar = () => ctx.scheduler.every(rule, 'tick');
      cancelar = (id) => ctx.scheduler.cancel(id);
    },
  });
  return { plugin, vistos, every: () => agendar(), cancel: (id: string) => cancelar(id) };
}

describe('TestBot: scheduler.every', () => {
  it('intervalo: 3 ocorrências com scheduledAt exato e o mesmo seriesId', async () => {
    const t0 = Date.now();
    const { plugin, vistos, every } = lembrete({ everyMs: MIN });
    bots.push(await createTestBot({ plugins: [plugin] }));

    const id = await every();
    await vi.advanceTimersByTimeAsync(3 * MIN);

    expect(vistos).toEqual([
      { scheduledAt: t0 + MIN, seriesId: id },
      { scheduledAt: t0 + 2 * MIN, seriesId: id },
      { scheduledAt: t0 + 3 * MIN, seriesId: id },
    ]);
  });

  it('calendário diário: cancel no meio encerra a série', async () => {
    vi.setSystemTime(Date.UTC(2026, 5, 1, 10, 0)); // 07:00 em São Paulo (UTC-3, sem verão)
    const { plugin, vistos, every, cancel } = lembrete({
      time: '08:00',
      timeZone: 'America/Sao_Paulo',
    });
    bots.push(await createTestBot({ plugins: [plugin] }));

    const id = await every();
    await vi.advanceTimersByTimeAsync(2 * DAY);
    expect(vistos.map((v) => v.scheduledAt)).toEqual([
      Date.UTC(2026, 5, 1, 11, 0),
      Date.UTC(2026, 5, 2, 11, 0),
    ]);

    expect(await cancel(id)).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(vistos).toHaveLength(2);
  });
});
