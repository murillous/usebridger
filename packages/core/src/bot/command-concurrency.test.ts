// `concurrency` no comando (ADR 0084): teto de `run` simultâneos no bot, somando os chats.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CommandContext, command } from '#commands/command.ts';
import type { PluginErrorEvent } from '#events/types.ts';
import { definePlugin } from '#plugin/define.ts';
import { type Bot, createBot } from './bot.ts';
import {
  deferred,
  message,
  RecordingTransport,
  recordingLogger,
  sentTexts,
} from './harness.test-support.ts';
import { CommandTimeoutError } from './plugin-context.ts';

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

interface Setup {
  readonly run: (c: CommandContext) => unknown;
  readonly background?: boolean;
}

async function startBot({ run, background }: Setup) {
  const transport = new RecordingTransport();
  const logger = recordingLogger();
  const errors: PluginErrorEvent[] = [];
  const plugin = definePlugin({
    name: 'midia',
    version: '1.0.0',
    engine: '>=0.0.0',
    setup(ctx) {
      ctx.commands.add(
        command({ name: 'converter', concurrency: 1, timeoutMs: 5000, background, run }),
      );
      ctx.commands.add(command({ name: 'ping', run: () => 'pong' }));
      ctx.events.on('plugin.error', (e) => {
        errors.push(e.payload);
      });
    },
  });
  const bot = createBot({
    transport,
    logger,
    env: {},
    plugins: [plugin],
    outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
    timeouts: { commandMs: 1000 },
  });
  bots.push(bot);
  await bot.start();
  return { transport, errors, logger };
}

describe('Bot: limite de concorrência por comando (ADR 0084)', () => {
  it('a execução excedente de outro chat espera a vaga', async () => {
    const ffmpeg = deferred();
    const started: string[] = [];
    const { transport } = await startBot({
      run: async (c) => {
        started.push(c.message.chat.id);
        if (started.length === 1) await ffmpeg.promise;
        return 'pronto';
      },
    });

    transport.emit('message', message('!converter', { chatId: 'a@test' }));
    transport.emit('message', message('!converter', { chatId: 'b@test' }));
    transport.emit('message', message('!ping', { chatId: 'c@test' }));
    await vi.advanceTimersByTimeAsync(0);
    // Outros comandos não entram no teto.
    expect(started).toEqual(['a@test']);
    expect(sentTexts(transport)).toEqual(['pong']);

    ffmpeg.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(['a@test', 'b@test']);
    expect(sentTexts(transport)).toEqual(['pong', 'pronto', 'pronto']);
  });

  it('a espera conta no prazo: estourado na fila, não roda e vira plugin.error', async () => {
    const started: string[] = [];
    const { transport, errors, logger } = await startBot({
      run: (c) => {
        started.push(c.message.chat.id);
        return new Promise(() => undefined);
      },
    });

    transport.emit('message', message('!converter', { chatId: 'a@test' }));
    await vi.advanceTimersByTimeAsync(3000);
    transport.emit('message', message('!converter', { chatId: 'b@test' }));
    await vi.advanceTimersByTimeAsync(2000);
    // O primeiro estourou e o segundo ainda espera: o `run` preso segura a vaga.
    expect(errors).toHaveLength(1);
    expect(started).toEqual(['a@test']);

    await vi.advanceTimersByTimeAsync(3000);
    expect(started).toEqual(['a@test']);
    expect(errors).toHaveLength(2);
    expect(errors[1]?.timedOut).toBe(true);
    expect(errors[1]?.error).toBeInstanceOf(CommandTimeoutError);
    // O prazo estourado na espera não é registrado de novo como rejeição tardia.
    expect(logger.lines.some((line) => line.message.includes('depois do prazo'))).toBe(false);
  });

  it('com background, a espera não segura o chat', async () => {
    const ffmpeg = deferred();
    const { transport } = await startBot({
      background: true,
      run: async () => {
        await ffmpeg.promise;
        return 'pronto';
      },
    });

    transport.emit('message', message('!converter'));
    transport.emit('message', message('!converter'));
    transport.emit('message', message('!ping'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sentTexts(transport)).toEqual(['pong']);

    ffmpeg.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(sentTexts(transport)).toEqual(['pong', 'pronto', 'pronto']);
  });
});
