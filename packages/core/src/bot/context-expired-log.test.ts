// Rótulo `context` do evento `context.expired` (ADR 0118): diz de qual contexto veio a recusa.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { command } from '#commands/command.ts';
import type { ExpireContext } from '#conversations/conversations.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext } from '#plugin/types.ts';
import { type Bot, createBot } from './bot.ts';
import { message, RecordingTransport, recordingLogger } from './harness.test-support.ts';

const bots: Bot[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const created of bots.splice(0)) {
    const stopped = created.stop().catch(() => undefined);
    await vi.runAllTimersAsync();
    await stopped;
  }
  vi.useRealTimers();
});

/** Sobe o bot com o plugin `p`, manda `!p` e devolve o logger e o transport. */
// `settle: false` para handler que só termina no prazo: esperar o bot assentar travaria o relógio falso.
async function boot(setup: (ctx: PluginContext) => void, settle = true) {
  const transport = new RecordingTransport();
  const logger = recordingLogger();
  const bot = createBot({
    transport,
    logger,
    env: {},
    plugins: [definePlugin({ name: 'p', version: '1.0.0', engine: '>=0.0.0', setup })],
    outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
    timeouts: { commandMs: 500 },
  });
  bots.push(bot);
  await bot.start();
  transport.emit('message', message('!p'));
  if (settle) await bot.settled();
  return { bot, transport, logger };
}

const expired = (logger: ReturnType<typeof recordingLogger>) =>
  logger.lines.filter((line) => line.fields['event'] === 'context.expired');

describe('context.expired leva o rótulo do contexto (ADR 0118)', () => {
  it('passo que estourou o prazo: context "step"', async () => {
    let late: ((text: string) => Promise<unknown>) | undefined;
    const { bot, transport, logger } = await boot((ctx) => {
      ctx.commands.add(command({ name: 'p', run: (c) => c.expectReply('passo') }));
      ctx.conversations.define('passo', (c) => {
        late = c.reply;
        return new Promise(() => undefined);
      });
    });
    transport.emit('message', message('resposta'));
    await vi.advanceTimersByTimeAsync(600);
    await late?.('tarde').catch(() => undefined);
    await bot.settled();

    expect(expired(logger)).toHaveLength(1);
    expect(expired(logger)[0]?.fields).toMatchObject({ step: 'passo', context: 'step' });
  });

  it('onExpire que estourou o prazo: context "expire" e binding chat', async () => {
    let ctxExpire: ExpireContext | undefined;
    const { bot, logger } = await boot((ctx) => {
      ctx.commands.add(
        command({
          name: 'p',
          run: (c) => c.expectReply('passo', { ttlMs: 1000 }),
        }),
      );
      ctx.conversations.define('passo', () => undefined, {
        onExpire: (c) => {
          ctxExpire = c;
          c.log.info('no onExpire');
          return new Promise(() => undefined);
        },
      });
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(600);
    await ctxExpire?.reply('tarde').catch(() => undefined);
    await bot.settled();

    expect(logger.lines.find((line) => line.message === 'no onExpire')?.fields).toMatchObject({
      chat: expect.stringMatching(/^u_[\w-]{22}$/),
    });
    expect(expired(logger)).toHaveLength(1);
    expect(expired(logger)[0]?.fields).toMatchObject({ step: 'passo', context: 'expire' });
  });

  it('comando que estourou o prazo: context "command"', async () => {
    let late: ((text: string) => Promise<unknown>) | undefined;
    const { bot, logger } = await boot((ctx) => {
      ctx.commands.add(
        command({
          name: 'p',
          run: (c) => {
            late = c.reply;
            return new Promise(() => undefined);
          },
        }),
      );
    }, false);
    await vi.advanceTimersByTimeAsync(600);
    await late?.('tarde').catch(() => undefined);
    await bot.settled();

    expect(expired(logger)).toHaveLength(1);
    expect(expired(logger)[0]?.fields).toMatchObject({ command: 'p', context: 'command' });
  });

  it('listener que estourou o prazo: context "listener"', async () => {
    let late: ((text: string) => Promise<unknown>) | undefined;
    const { bot, logger } = await boot((ctx) => {
      ctx.events.on('message', { timeoutMs: 1000 }, (e) => {
        late = e.reply;
        return new Promise(() => undefined);
      });
    }, false);
    await vi.advanceTimersByTimeAsync(1100);
    await late?.('tarde').catch(() => undefined);
    await bot.settled();

    expect(expired(logger)).toHaveLength(1);
    expect(expired(logger)[0]?.fields).toMatchObject({ eventName: 'message', context: 'listener' });
  });
});
