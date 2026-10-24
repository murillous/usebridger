// Lacunas da trilha (ADR 0120, #246): job com falha e timeout, envio dentro do job, passos,
// edições, fila cheia e a validação do `trail`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { command } from '#commands/command.ts';
import { BotConfigError } from '#config/owners.ts';
import * as LOG from '#logger/events.ts';
import { createLogger } from '#logger/logger.ts';
import { assertTrailMode } from '#logger/trail.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext } from '#plugin/types.ts';
import { InboundQueue } from '#queue/inbound.ts';
import { TenantScope } from '#tenant/scope.ts';
import { type Bot, type BotConfig, createBot } from './bot.ts';
import { deferred, message, RecordingTransport } from './harness.test-support.ts';
import { ReadyGate } from './ready-gate.ts';
import { createTransportEntry } from './transport-entry.ts';

const TRACE = /^[0-9a-f]{32}$/;
const bots: Bot[] = [];

afterEach(async () => {
  for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
});

type Line = Record<string, unknown>;

async function start(setup: (ctx: PluginContext) => void, config: Partial<BotConfig> = {}) {
  const lines: Line[] = [];
  const transport = new RecordingTransport();
  const created = createBot({
    transport,
    logger: createLogger({
      level: 'info',
      destination: { write: (line) => lines.push(JSON.parse(line) as Line) },
    }),
    outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
    env: {},
    plugins: [definePlugin({ name: 'p', version: '1.0.0', engine: '>=0.0.0', setup })],
    ...config,
  });
  bots.push(created);
  await created.start();
  return { lines, transport, bot: created };
}

const byEvent = (lines: Line[], event: string): Line[] => lines.filter((l) => l['event'] === event);

/** `!agenda` agenda o job `j` para daqui a 5 ms. */
function agenda(ctx: PluginContext): void {
  ctx.commands.add(
    command({
      name: 'agenda',
      run: async () => {
        await ctx.scheduler.at(Date.now() + 5, 'j');
      },
    }),
  );
}

describe('job.run', () => {
  it.each([
    ['failed', () => Promise.reject(new Error('quebrou')), {}],
    ['timeout', () => new Promise<void>(() => undefined), { timeouts: { jobMs: 20 } }],
  ] as const)('status %s', async (status, handler, config) => {
    const { lines, transport } = await start((ctx) => {
      ctx.scheduler.on('j', handler);
      agenda(ctx);
    }, config);
    transport.emit('message', message('!agenda'));
    await vi.waitFor(() => expect(byEvent(lines, 'job.run')).toHaveLength(1));
    expect(byEvent(lines, 'job.run')[0]).toMatchObject({ job: 'j', plugin: 'p', status });
  });

  it('o envio feito dentro do job sai com o trace do job', async () => {
    const { lines, transport } = await start((ctx) => {
      ctx.scheduler.on('j', async () => {
        await ctx.send.send('outro@test', { type: 'text', text: 'oi' });
      });
      agenda(ctx);
    });
    transport.emit('message', message('!agenda'));
    await vi.waitFor(() => expect(byEvent(lines, 'job.run')).toHaveLength(1));
    await vi.waitFor(() => expect(byEvent(lines, 'outbound.sent')).toHaveLength(1));
    const trace = byEvent(lines, 'job.run')[0]?.['trace'];
    expect(trace).toMatch(TRACE);
    expect(byEvent(lines, 'outbound.sent')[0]?.['trace']).toBe(trace);
  });
});

describe('passos', () => {
  it('step.entered sai no trace da mensagem e step.expired no da expiração', async () => {
    const { lines, transport } = await start((ctx) => {
      ctx.commands.add(
        command({ name: 'c', run: (c) => c.expectReply('s', { ttlMs: 30, data: {} }) }),
      );
      ctx.conversations.define('s', () => undefined, { onExpire: (c) => c.reply('fim') });
    });
    transport.emit('message', message('!c'));
    await vi.waitFor(() => expect(byEvent(lines, 'step.expired')).toHaveLength(1));

    const received = byEvent(lines, 'message.received')[0]?.['trace'];
    const entered = byEvent(lines, 'step.entered')[0];
    const expired = byEvent(lines, 'step.expired')[0];
    expect(entered).toMatchObject({ plugin: 'p', step: 's', trace: received });
    expect(expired).toMatchObject({ plugin: 'p', step: 's' });
    expect(expired?.['trace']).toMatch(TRACE);
    expect(expired?.['trace']).not.toBe(received);
  });
});

describe('edições', () => {
  it('geram message.received e message.handled com route edit, no mesmo trace', async () => {
    const { lines, transport, bot } = await start((ctx) => {
      ctx.events.on('message.edited', () => undefined);
    });
    transport.emit('message.edited', { ...message('depois'), isEdited: true } as never);
    await vi.waitFor(() => expect(byEvent(lines, 'message.handled')).toHaveLength(1));
    await bot.settled();

    const [received] = byEvent(lines, 'message.received');
    const [handled] = byEvent(lines, 'message.handled');
    expect(handled).toMatchObject({ route: 'edit', status: 'ok' });
    expect(handled?.['trace']).toBe(received?.['trace']);
    expect(JSON.stringify(lines)).not.toContain('depois');
  });
});

describe('fila de entrada cheia', () => {
  it('a expiração descartada emite step.expired', () => {
    const emitted: { name: string; fields: unknown }[] = [];
    const hold = deferred();
    const inbound = new InboundQueue({ onError: () => undefined, maxPendingPerChat: 0 });
    inbound.enqueue('chat@test', () => hold.promise);
    const entry = createTransportEntry({
      inbound,
      tenants: new TenantScope(),
      conversations: { expire: () => ({ plugin: 'p', step: 's' }) },
      gate: new ReadyGate(),
      stopping: () => false,
      log: () => ({ event: () => undefined }),
      trail: {
        enabled: () => true,
        emit: (event: { name: string }, fields: unknown) =>
          emitted.push({ name: event.name, fields }),
      },
    } as never);

    entry.expireWait({ id: 'chat@test' } as never, { id: 'u@test' } as never);

    expect(emitted).toEqual([{ name: LOG.stepExpired.name, fields: { plugin: 'p', step: 's' } }]);
    hold.resolve();
  });
});

describe('assertTrailMode', () => {
  it('lança BotConfigError para valor inválido e aceita os válidos', () => {
    expect(() => assertTrailMode('x')).toThrow(BotConfigError);
    for (const ok of [undefined, 'info', 'debug', 'off']) {
      expect(() => assertTrailMode(ok)).not.toThrow();
    }
  });
});
