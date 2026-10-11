// Comando com `background: true` (ADR 0087): o `run` sai da fila do chat e mantém o contexto,
// o prazo e o destino do erro.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CommandContext, command } from '#commands/command.ts';
import type { CommandEvent, PluginErrorEvent } from '#events/types.ts';
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
  readonly timeoutMs?: number;
}

async function startBot({ run, timeoutMs }: Setup): Promise<{
  bot: Bot;
  transport: RecordingTransport;
  errors: PluginErrorEvent[];
  commands: Pick<CommandEvent, 'name' | 'status'>[];
}> {
  const transport = new RecordingTransport();
  const errors: PluginErrorEvent[] = [];
  const commands: Pick<CommandEvent, 'name' | 'status'>[] = [];
  const plugin = definePlugin({
    name: 'midia',
    version: '1.0.0',
    engine: '>=0.0.0',
    setup(ctx) {
      ctx.commands.add(
        command({ name: 'baixar', background: true, ...(timeoutMs && { timeoutMs }), run }),
      );
      ctx.commands.add(command({ name: 'ping', run: () => 'pong' }));
      ctx.events.on('plugin.error', (e) => {
        errors.push(e.payload);
      });
      ctx.events.on('command', (e) => {
        commands.push({ name: e.payload.name, status: e.payload.status });
      });
    },
  });
  const bot = createBot({
    transport,
    logger: recordingLogger(),
    env: {},
    plugins: [plugin],
    outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
    timeouts: { commandMs: 1000 },
  });
  bots.push(bot);
  await bot.start();
  return { bot, transport, errors, commands };
}

describe('Bot: comando em segundo plano (ADR 0087)', () => {
  it('não segura o chat, e o reply tardio cita a mensagem original', async () => {
    const download = deferred();
    const { transport, commands } = await startBot({
      run: async (c) => {
        await c.reply('baixando…');
        await download.promise;
        await c.reply('pronto');
      },
    });
    const original = message('!baixar');

    transport.emit('message', original);
    transport.emit('message', message('!ping')); // mesmo chat: não espera o download
    await vi.advanceTimersByTimeAsync(0);
    expect(sentTexts(transport)).toEqual(['baixando…', 'pong']);
    expect(commands).toEqual([{ name: 'ping', status: 'ran' }]);

    download.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(sentTexts(transport)).toEqual(['baixando…', 'pong', 'pronto']);
    expect(transport.sent[2]?.options?.quoted).toBe(original);
    // O `command` sai quando o `run` termina, não quando o chat é liberado.
    expect(commands).toEqual([
      { name: 'ping', status: 'ran' },
      { name: 'baixar', status: 'ran' },
    ]);
  });

  it('a falha vai para plugin.error e o command sai com failed', async () => {
    const boom = new Error('yt-dlp falhou');
    const { transport, errors, commands } = await startBot({
      run: async () => {
        await Promise.resolve();
        throw boom;
      },
    });

    transport.emit('message', message('!baixar'));
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toEqual([
      { plugin: 'midia', phase: 'command', event: 'baixar', error: boom, timedOut: false },
    ]);
    expect(commands).toEqual([{ name: 'baixar', status: 'failed' }]);
  });

  it('o timeoutMs do comando vale fora da fila: estourado, aborta o signal', async () => {
    let signal: AbortSignal | undefined;
    const { transport, errors } = await startBot({
      timeoutMs: 5000,
      run: (c) => {
        signal = c.signal;
        return new Promise(() => undefined);
      },
    });

    transport.emit('message', message('!baixar'));
    await vi.advanceTimersByTimeAsync(4999);
    expect(errors).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.timedOut).toBe(true);
    expect(errors[0]?.error).toBeInstanceOf(CommandTimeoutError);
  });

  it('settled() espera o run em segundo plano', async () => {
    const download = deferred();
    const { bot, transport } = await startBot({
      run: async (c) => {
        await download.promise;
        await c.reply('pronto');
      },
    });

    transport.emit('message', message('!baixar'));
    let settled = false;
    void bot.settled().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    download.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(sentTexts(transport)).toEqual(['pronto']);
  });

  it('o stop aborta o signal, e um run que o ignora não prende o settled()', async () => {
    let signal: AbortSignal | undefined;
    const { bot, transport } = await startBot({
      run: (c) => {
        signal = c.signal;
        return new Promise(() => undefined);
      },
    });

    transport.emit('message', message('!baixar'));
    await vi.advanceTimersByTimeAsync(0);
    const settled = bot.settled();

    const stopped = bot.stop();
    await vi.runAllTimersAsync();
    await stopped;
    expect(signal?.aborted).toBe(true);
    await expect(settled).resolves.toBeUndefined();
  });
});
