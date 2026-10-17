// ADR 0106 (#148): `ctx.observe` com `message.handled` e `outbound.sent`, síncronos, por bot.

import { afterEach, describe, expect, it } from 'vitest';
import { command } from '#commands/command.ts';
import type { PluginErrorEvent } from '#events/types.ts';
import type { MessageHandledSignal, OutboundSentSignal } from '#observers/observers.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext } from '#plugin/types.ts';
import { type Bot, type BotConfig, createBot } from './bot.ts';
import { deferred, message, RecordingTransport, recordingLogger } from './harness.test-support.ts';

const bots: Bot[] = [];

afterEach(async () => {
  for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
});

interface Seen {
  readonly handled: MessageHandledSignal[];
  readonly sent: OutboundSentSignal[];
  readonly errors: PluginErrorEvent[];
}

async function startBot(
  transport: RecordingTransport,
  setup: (ctx: PluginContext) => void,
  config: Partial<BotConfig> = {},
): Promise<{ bot: Bot; seen: Seen }> {
  const seen: Seen = { handled: [], sent: [], errors: [] };
  const plugin = definePlugin({
    name: 'p',
    version: '1.0.0',
    engine: '>=0.0.0',
    setup(ctx) {
      ctx.observe('message.handled', (signal) => seen.handled.push(signal));
      ctx.observe('outbound.sent', (signal) => seen.sent.push(signal));
      ctx.events.on('plugin.error', (e) => {
        seen.errors.push(e.payload);
      });
      setup(ctx);
    },
  });
  const bot = createBot({
    transport,
    logger: recordingLogger(),
    env: {},
    outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
    ...config,
    plugins: [plugin, ...(config.plugins ?? [])],
  });
  bots.push(bot);
  await bot.start();
  return { bot, seen };
}

describe('ctx.observe (ADR 0106)', () => {
  it('`message.handled` do comando com o nome canônico e `outbound.sent` da resposta com `replyTo`', async () => {
    const transport = new RecordingTransport();
    const { bot, seen } = await startBot(transport, (ctx) => {
      ctx.commands.add(command({ name: 'ping', aliases: ['p'], run: (c) => c.reply('pong') }));
    });

    const ping = message('!p');
    transport.emit('message', ping);
    await bot.settled();

    expect(seen.handled).toEqual([
      {
        messageId: ping.id,
        chatId: 'chat@test',
        senderId: 'user@test',
        chatType: 'private',
        route: 'command',
        command: 'ping',
        status: 'ok',
        queuedMs: expect.any(Number),
        durationMs: expect.any(Number),
      },
    ]);
    expect(seen.sent).toEqual([
      {
        chatId: 'chat@test',
        chatType: 'private',
        kind: 'text',
        status: 'sent',
        queuedMs: expect.any(Number),
        retries: 0,
        replyTo: ping.id,
      },
    ]);
    const [handled] = seen.handled;
    expect(handled?.queuedMs).toBeGreaterThanOrEqual(0);
    expect(handled?.durationMs).toBeGreaterThanOrEqual(0);
    // A opção interna da origem não chega ao transport.
    expect(Object.getOwnPropertySymbols(transport.sent[0]?.options ?? {})).toEqual([]);
  });

  it('status do comando: recusado, falho e estourado', async () => {
    const transport = new RecordingTransport();
    const { bot, seen } = await startBot(
      transport,
      (ctx) => {
        ctx.commands.add(command({ name: 'dono', role: 'owner', run: () => undefined }));
        ctx.commands.add(
          command({
            name: 'quebra',
            run: () => {
              throw new Error('boom');
            },
          }),
        );
        ctx.commands.add(command({ name: 'lento', run: () => new Promise(() => undefined) }));
      },
      { timeouts: { commandMs: 20 } },
    );

    for (const text of ['!dono', '!quebra', '!lento']) transport.emit('message', message(text));
    await bot.settled();

    expect(seen.handled.map(({ command: name, status }) => [name, status])).toEqual([
      ['dono', 'refused'],
      ['quebra', 'failed'],
      ['lento', 'timeout'],
    ]);
  });

  it('`message.handled` dos listeners de `message` e do passo de conversa', async () => {
    const transport = new RecordingTransport();
    const { bot, seen } = await startBot(transport, (ctx) => {
      ctx.commands.add(command({ name: 'pergunta', run: (c) => c.expectReply('resposta') }));
      ctx.conversations.define('resposta', () => undefined);
      ctx.events.on('message', (e) => {
        if (e.text === 'falha') throw new Error('boom');
      });
    });

    for (const text of ['oi', 'falha', '!pergunta', 'sim'])
      transport.emit('message', message(text));
    await bot.settled();

    expect(seen.handled.map(({ route, status }) => [route, status])).toEqual([
      ['message', 'ok'],
      ['message', 'failed'],
      ['command', 'ok'],
      ['step', 'ok'],
    ]);
  });

  it('`ctx.send` direto sai sem `chatType` nem `replyTo`', async () => {
    const transport = new RecordingTransport();
    let send: PluginContext['send'] | undefined;
    const { seen } = await startBot(transport, (ctx) => {
      send = ctx.send;
    });

    await send?.send('outro@test', 'aviso');

    expect(seen.sent).toEqual([
      {
        chatId: 'outro@test',
        kind: 'text',
        status: 'sent',
        queuedMs: expect.any(Number),
        retries: 0,
      },
    ]);
  });

  it('observador que lança vira `plugin.error` com `phase: observer`; os demais seguem', async () => {
    const transport = new RecordingTransport();
    const calls: string[] = [];
    const { bot, seen } = await startBot(transport, (ctx) => {
      ctx.observe('message.handled', () => {
        throw new Error('boom');
      });
      ctx.observe('message.handled', () => calls.push('depois'));
      ctx.events.on('message', () => undefined);
    });

    transport.emit('message', message('oi'));
    await bot.settled();

    expect(calls).toEqual(['depois']);
    expect(seen.handled).toHaveLength(1);
    expect(seen.errors).toMatchObject([
      { plugin: 'p', phase: 'observer', event: 'message.handled', timedOut: false },
    ]);
  });

  it('o observador não é aguardado: não segura o chat', async () => {
    const transport = new RecordingTransport();
    const gate = deferred();
    const order: string[] = [];
    const { bot } = await startBot(transport, (ctx) => {
      // Uma promise devolvida pelo observador é ignorada.
      ctx.observe('message.handled', (() => gate.promise) as () => void);
      ctx.events.on('message', (e) => {
        order.push(e.text ?? '');
      });
    });

    transport.emit('message', message('um'));
    transport.emit('message', message('dois'));
    await bot.settled();

    expect(order).toEqual(['um', 'dois']);
    gate.resolve();
  });

  it('a assinatura sai com o unsubscribe e no dispose do plugin', async () => {
    const transport = new RecordingTransport();
    const kept: string[] = [];
    const dropped: string[] = [];
    const outro = definePlugin({
      name: 'outro',
      version: '1.0.0',
      engine: '>=0.0.0',
      setup(ctx) {
        ctx.observe('message.handled', (s) => kept.push(s.messageId));
        const off = ctx.observe('message.handled', (s) => dropped.push(s.messageId));
        off();
      },
    });
    const { bot } = await startBot(transport, (ctx) => ctx.events.on('message', () => undefined), {
      plugins: [outro],
    });

    const primeira = message('um');
    transport.emit('message', primeira);
    await bot.settled();
    await bot.plugins.disable('outro');
    transport.emit('message', message('dois'));
    await bot.settled();

    expect(kept).toEqual([primeira.id]);
    expect(dropped).toEqual([]);
  });

  it('com dois bots no processo, cada plugin vê só o seu', async () => {
    const transportA = new RecordingTransport();
    const transportB = new RecordingTransport();
    const a = await startBot(transportA, (ctx) => ctx.events.on('message', () => undefined));
    const b = await startBot(transportB, (ctx) => ctx.events.on('message', () => undefined));

    transportA.emit('message', message('oi'));
    await a.bot.settled();

    expect(a.seen.handled).toHaveLength(1);
    expect(b.seen.handled).toEqual([]);
  });

  it('sinal desconhecido ou observador que não é função lançam no setup', async () => {
    const errors: unknown[] = [];
    await startBot(new RecordingTransport(), (ctx) => {
      for (const call of [
        () => ctx.observe('nada' as 'message.handled', () => undefined),
        () => ctx.observe('message.handled', 'x' as unknown as () => void),
      ]) {
        try {
          call();
        } catch (error) {
          errors.push(error);
        }
      }
    });
    expect(errors).toEqual([expect.any(TypeError), expect.any(TypeError)]);
  });

  it('comando `background`: `message.handled` sai uma vez, só quando o `run` termina', async () => {
    const transport = new RecordingTransport();
    const gate = deferred();
    const { bot, seen } = await startBot(transport, (ctx) => {
      ctx.commands.add(
        command({ name: 'baixar', aliases: ['b'], background: true, run: () => gate.promise }),
      );
    });

    transport.emit('message', message('!b'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen.handled).toEqual([]);

    gate.resolve();
    await bot.settled();

    expect(seen.handled).toEqual([
      expect.objectContaining({
        route: 'command',
        command: 'baixar',
        status: 'ok',
        queuedMs: expect.any(Number),
        durationMs: expect.any(Number),
      }),
    ]);
  });

  it('comando `background` que lança sai com `status: failed`', async () => {
    const transport = new RecordingTransport();
    const { bot, seen } = await startBot(transport, (ctx) => {
      ctx.commands.add(
        command({
          name: 'baixar',
          background: true,
          run: async () => {
            throw new Error('boom');
          },
        }),
      );
    });

    transport.emit('message', message('!baixar'));
    await bot.settled();

    expect(seen.handled).toEqual([
      expect.objectContaining({ route: 'command', command: 'baixar', status: 'failed' }),
    ]);
  });

  it('clique em ação de comando e de passo: `message.handled` com a rota certa', async () => {
    const transport = new RecordingTransport(['send.text', 'quoted', 'actions']);
    const { bot, seen } = await startBot(transport, (ctx) => {
      ctx.commands.add(command({ name: 'notas', run: () => undefined }));
      ctx.conversations.define('periodo', () => undefined);
      ctx.commands.add(
        command({
          name: 'menu',
          run: (c) =>
            c.reply('Escolha:', {
              actions: [
                { label: 'Notas', command: 'notas' },
                { label: 'Período', step: 'periodo' },
              ],
            }),
        }),
      );
    });
    transport.emit('message', message('!menu'));
    await bot.settled();
    seen.handled.length = 0;

    const buttons = transport.sent.at(-1)?.options?.actions ?? [];
    for (const [i, button] of buttons.entries()) {
      transport.emit('interaction', {
        id: `click-${i}`,
        chat: { id: 'chat@test', isGroup: false },
        sender: { id: 'user@test', name: 'Usuária', phone: null },
        actionId: button.id,
        timestamp: Date.now(),
      });
      await bot.settled();
    }

    expect(seen.handled.map(({ route, command: name, status }) => [route, name, status])).toEqual([
      ['command', 'notas', 'ok'],
      ['step', undefined, 'ok'],
    ]);
    expect(seen.handled[0]).toMatchObject({
      queuedMs: expect.any(Number),
      durationMs: expect.any(Number),
    });
  });

  it('comando nativo (interaction): `message.handled` com o nome canônico', async () => {
    const transport = new RecordingTransport();
    const { bot, seen } = await startBot(transport, (ctx) => {
      ctx.commands.add(command({ name: 'notas', aliases: ['n'], run: () => undefined }));
    });

    transport.emit('interaction', {
      id: 'slash-1',
      chat: { id: 'chat@test', isGroup: false },
      sender: { id: 'user@test', name: 'Usuária', phone: null },
      command: 'n',
      args: '',
      timestamp: Date.now(),
    });
    await bot.settled();

    expect(seen.handled).toEqual([
      expect.objectContaining({
        route: 'command',
        command: 'notas',
        status: 'ok',
        queuedMs: expect.any(Number),
        durationMs: expect.any(Number),
      }),
    ]);
  });
});
