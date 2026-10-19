// `onExpire` no passo (ADR 0093, #89): a espera que vence sem resposta avisa o plugin dono, na
// fila do chat, só quando o TTL vence de fato.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { command } from '#commands/command.ts';
import { type ExpireContext, StepTimeoutError } from '#conversations/conversations.ts';
import { ContextExpiredError } from '#deadline.ts';
import type { PluginErrorEvent } from '#events/types.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext, PluginDefinition } from '#plugin/types.ts';
import { type Bot, type BotConfig, createBot } from './bot.ts';
import {
  deferred,
  message,
  RecordingTransport,
  recordingLogger,
  sentTexts,
} from './harness.test-support.ts';

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

function plugin(name: string, setup: (ctx: PluginContext) => void): PluginDefinition {
  return definePlugin({ name, version: '1.0.0', engine: '>=0.0.0', setup });
}

async function startBot(
  transport: RecordingTransport,
  plugins: PluginDefinition[],
  extra: Partial<BotConfig> = {},
): Promise<Bot> {
  const bot = createBot({
    transport,
    logger: recordingLogger(),
    env: {},
    plugins,
    outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
    ...extra,
  });
  bots.push(bot);
  await bot.start();
  return bot;
}

/**
 * `!cadastro` pergunta o nome com espera de 1 s; o passo responde e o `onExpire` avisa. `expired`
 * guarda os contextos de expiração; `heard`, as mensagens que chegaram aos listeners.
 */
function cadastro(
  expired: ExpireContext[] = [],
  heard: string[] = [],
  onExpire: (c: ExpireContext) => unknown = (c) => c.reply('Encerrei por falta de resposta.'),
): PluginDefinition {
  return plugin('cadastro', (ctx) => {
    ctx.commands.add(
      command({
        name: 'cadastro',
        run: (c) => c.expectReply('nome', { data: { etapa: 1 }, ttlMs: 1000 }),
      }),
    );
    ctx.commands.add(command({ name: 'ajuda', run: (c) => c.reply('ajuda') }));
    ctx.conversations.define('nome', (c) => c.reply(`Olá, ${c.text}`), {
      onExpire: (c) => {
        expired.push(c);
        return onExpire(c);
      },
    });
    ctx.events.on('message', (c) => {
      heard.push(c.message.text ?? '');
    });
  });
}

describe('Bot: onExpire do passo (ADR 0093)', () => {
  it('vencido o TTL, roda com chat, remetente, passo e data, e o reply sai no chat sem citar', async () => {
    const transport = new RecordingTransport();
    const expired: ExpireContext[] = [];
    const bot = await startBot(transport, [cadastro(expired)]);

    transport.emit('message', message('!cadastro', { sender: { id: 'ana@test' } }));
    await bot.settled();
    await vi.advanceTimersByTimeAsync(999);
    await bot.settled();
    expect(expired).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await bot.settled();

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      chat: { id: 'chat@test' },
      sender: { id: 'ana@test' },
      step: 'nome',
      data: { etapa: 1 },
    });
    expect(sentTexts(transport)).toEqual(['Encerrei por falta de resposta.']);
    expect(transport.sent[0]?.chatId).toBe('chat@test');
    expect(transport.sent[0]?.options?.quoted).toBeUndefined();
  });

  it('não roda quando a espera é respondida', async () => {
    const transport = new RecordingTransport();
    const expired: ExpireContext[] = [];
    const bot = await startBot(transport, [cadastro(expired)]);

    transport.emit('message', message('!cadastro'));
    transport.emit('message', message('Maria'));
    await bot.settled();
    await vi.advanceTimersByTimeAsync(5000);
    await bot.settled();

    expect(expired).toHaveLength(0);
    expect(sentTexts(transport)).toEqual(['Olá, Maria']);
  });

  it('não roda quando um comando digitado descarta a espera', async () => {
    const transport = new RecordingTransport();
    const expired: ExpireContext[] = [];
    const bot = await startBot(transport, [cadastro(expired)]);

    transport.emit('message', message('!cadastro'));
    transport.emit('message', message('!ajuda'));
    await bot.settled();
    await vi.advanceTimersByTimeAsync(5000);
    await bot.settled();

    expect(expired).toHaveLength(0);
    expect(sentTexts(transport)).toEqual(['ajuda']);
  });

  it('não roda quando outro plugin substitui a espera; o onExpire da nova é o que vale', async () => {
    const transport = new RecordingTransport();
    const expired: ExpireContext[] = [];
    const outros: string[] = [];
    const outro = plugin('outro', (ctx) => {
      ctx.commands.add(
        command({ name: 'pesquisa', run: (c) => c.expectReply('nota', { ttlMs: 3000 }) }),
      );
      ctx.conversations.define('nota', () => undefined, {
        onExpire: (c) => {
          outros.push(c.step);
        },
      });
    });
    const bot = await startBot(transport, [cadastro(expired), outro]);

    transport.emit('message', message('!cadastro'));
    transport.emit('message', message('!pesquisa'));
    await bot.settled();
    await vi.advanceTimersByTimeAsync(3000);
    await bot.settled();

    expect(expired).toHaveLength(0);
    expect(outros).toEqual(['nota']);
  });

  it('não roda depois do reload do plugin nem no stop()', async () => {
    const transport = new RecordingTransport();
    const expired: string[] = [];
    const recarregavel = definePlugin({
      name: 'recarregavel',
      version: '1.0.0',
      engine: '>=0.0.0',
      config: z.object({ versao: z.string().default('v1') }),
      setup(ctx) {
        ctx.commands.add(
          command({ name: 'p', run: (c) => c.expectReply('passo', { ttlMs: 1000 }) }),
        );
        ctx.conversations.define('passo', () => undefined, {
          onExpire: (c) => {
            expired.push(c.step);
          },
        });
      },
    });
    const bot = await startBot(transport, [recarregavel]);

    transport.emit('message', message('!p'));
    await bot.settled();
    await bot.config.setOverrides('recarregavel', { versao: 'v2' });
    await vi.advanceTimersByTimeAsync(2000);
    await bot.settled();
    expect(expired).toEqual([]);

    transport.emit('message', message('!p'));
    await bot.settled();
    await bot.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(expired).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('encadeia outra espera: "Ainda está aí?" e a resposta vai ao passo', async () => {
    const transport = new RecordingTransport();
    const bot = await startBot(transport, [
      cadastro([], [], async (c) => {
        await c.reply('Ainda está aí?');
        c.expectReply('nome', { ttlMs: 500 });
      }),
    ]);

    transport.emit('message', message('!cadastro'));
    await bot.settled();
    await vi.advanceTimersByTimeAsync(1000);
    await bot.settled();
    transport.emit('message', message('João'));
    await bot.settled();

    expect(sentTexts(transport)).toEqual(['Ainda está aí?', 'Olá, João']);
  });

  it('a mensagem que entrou na fila antes do vencimento ainda responde', async () => {
    const transport = new RecordingTransport();
    const expired: ExpireContext[] = [];
    const gate = deferred();
    const lento = plugin('lento', (ctx) => {
      ctx.commands.add(command({ name: 'lento', run: () => gate.promise }));
    });
    const bot = await startBot(transport, [cadastro(expired), lento]);

    transport.emit('message', message('!cadastro'));
    await bot.settled();
    // Outra pessoa segura o chat; a resposta entra na fila antes de a espera vencer.
    transport.emit('message', message('!lento', { sender: { id: 'outra@test' } }));
    transport.emit('message', message('Maria'));
    await vi.advanceTimersByTimeAsync(1000);
    gate.resolve();
    await bot.settled();

    expect(expired).toHaveLength(0);
    expect(sentTexts(transport)).toEqual(['Olá, Maria']);
  });

  it('a expiração que entrou na fila antes da mensagem ganha, e a mensagem segue o fluxo normal', async () => {
    const transport = new RecordingTransport();
    const expired: ExpireContext[] = [];
    const heard: string[] = [];
    const gate = deferred();
    const lento = plugin('lento', (ctx) => {
      ctx.commands.add(command({ name: 'lento', run: () => gate.promise }));
    });
    const bot = await startBot(transport, [cadastro(expired, heard), lento]);

    transport.emit('message', message('!cadastro'));
    await bot.settled();
    transport.emit('message', message('!lento', { sender: { id: 'outra@test' } }));
    await vi.advanceTimersByTimeAsync(1000);
    transport.emit('message', message('Maria'));
    gate.resolve();
    await bot.settled();

    expect(expired).toHaveLength(1);
    expect(heard).toEqual(['Maria']);
    expect(sentTexts(transport)).toEqual(['Encerrei por falta de resposta.']);
  });

  it('o settled() espera o onExpire que está rodando', async () => {
    const transport = new RecordingTransport();
    const gate = deferred();
    let done = false;
    const bot = await startBot(transport, [
      cadastro([], [], async () => {
        await gate.promise;
        done = true;
      }),
    ]);

    transport.emit('message', message('!cadastro'));
    await bot.settled();
    await vi.advanceTimersByTimeAsync(1000);
    let settled = false;
    const waiting = bot.settled().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    gate.resolve();
    await waiting;
    expect(done).toBe(true);
  });

  it('a falha vira plugin.error com phase step-expire e o nome do passo', async () => {
    const transport = new RecordingTransport();
    const errors: PluginErrorEvent[] = [];
    const observer = plugin('obs', (ctx) => {
      ctx.events.on('plugin.error', (c) => {
        errors.push(c.payload);
      });
    });
    const bot = await startBot(transport, [
      cadastro([], [], () => {
        throw new Error('quebrou');
      }),
      observer,
    ]);

    transport.emit('message', message('!cadastro'));
    await bot.settled();
    await vi.advanceTimersByTimeAsync(1000);
    await bot.settled();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      plugin: 'cadastro',
      phase: 'step-expire',
      event: 'nome',
      timedOut: false,
    });
    expect(errors[0]?.error).toMatchObject({ message: 'quebrou' });
  });

  it('tem o prazo do comando: estourado, aborta o signal com StepTimeoutError e recusa efeitos', async () => {
    const transport = new RecordingTransport();
    const errors: PluginErrorEvent[] = [];
    let ctx: ExpireContext | undefined;
    const observer = plugin('obs', (c) => {
      c.events.on('plugin.error', (e) => {
        errors.push(e.payload);
      });
    });
    const bot = await startBot(
      transport,
      [
        cadastro([], [], (c) => {
          ctx = c;
          return new Promise(() => undefined);
        }),
        observer,
      ],
      { timeouts: { commandMs: 500 } },
    );

    transport.emit('message', message('!cadastro'));
    await bot.settled();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(500);
    await bot.settled();

    expect(ctx?.signal.aborted).toBe(true);
    expect(ctx?.signal.reason).toBeInstanceOf(StepTimeoutError);
    expect(ctx?.signal.reason).toMatchObject({ step: 'nome', stage: 'onExpire' });
    expect(errors[0]).toMatchObject({ phase: 'step-expire', event: 'nome', timedOut: true });
    await expect(ctx?.reply('tarde')).rejects.toBeInstanceOf(ContextExpiredError);
    expect(() => ctx?.expectReply('nome')).toThrow(ContextExpiredError);
  });

  it('onExpire que não é função falha o setup do plugin e derruba o boot', async () => {
    const transport = new RecordingTransport();
    const invalido = plugin('invalido', (ctx) =>
      ctx.conversations.define('passo', () => undefined, {
        onExpire: 'nao' as unknown as () => void,
      }),
    );
    await expect(startBot(transport, [invalido])).rejects.toMatchObject({
      name: 'PluginBootError',
      plugin: 'invalido',
      reason: { kind: 'setup-failed' },
    });
  });
});
