// `ctx.t` (ADR 0092): as `messages` do plugin com `{prefix}` do chat e os valores do plugin, no
// comando, no passo e no listener de mensagem.

import { afterEach, describe, expect, it } from 'vitest';
import { command } from '#commands/command.ts';
import { definePlugin } from '#plugin/define.ts';
import { type Bot, createBot } from './bot.ts';
import { message, RecordingTransport, recordingLogger, sentTexts } from './harness.test-support.ts';

const bots: Bot[] = [];

afterEach(async () => {
  for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
});

const media = definePlugin({
  name: 'midia',
  version: '1.0.0',
  engine: '>=0.0.0',
  messages: {
    uso: 'Use {prefix}sticker respondendo uma imagem',
    adicionado: 'PDF adicionado ({count}).',
    nome: 'Qual o nome, {quem}?',
    salvo: 'Salvo: {nome}',
  },
  setup(ctx) {
    ctx.commands.add(command({ name: 'sticker', run: (c) => c.t('uso') }));
    ctx.commands.add(command({ name: 'merge', run: ({ t }) => t('adicionado', { count: 2 }) }));
    ctx.commands.add(
      command({
        name: 'perfil',
        run: async (c) => {
          await c.reply(c.t('nome', { quem: 'você' }));
          c.expectReply('nome');
        },
      }),
    );
    ctx.conversations.define('nome', (s) => s.reply(s.t('salvo', { nome: s.text ?? '' })));
    ctx.commands.add(
      command({ name: 'prefixo', run: (c) => ctx.prefixes.set(c.message.chat.id, '/') }),
    );
    ctx.events.on('message', async (e) => {
      if (e.text === 'ajuda') await e.reply(e.t('uso'));
    });
  },
});

async function start(env: Record<string, string> = {}) {
  const transport = new RecordingTransport();
  const bot = createBot({
    transport,
    logger: recordingLogger(),
    env,
    plugins: [media],
    outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
  });
  bots.push(bot);
  await bot.start();
  const say = async (text: string): Promise<void> => {
    transport.emit('message', message(text));
    await bot.settled();
  };
  return { bot, transport, say };
}

describe('ctx.t (ADR 0092)', () => {
  it('preenche {prefix} com o do chat, que acompanha o prefixes.set', async () => {
    const { transport, say } = await start();
    await say('!sticker');
    await say('!prefixo');
    await say('/sticker');
    expect(sentTexts(transport)).toEqual([
      'Use !sticker respondendo uma imagem',
      'Use /sticker respondendo uma imagem',
    ]);
  });

  it('valores do plugin, com t desestruturado, no passo e no listener', async () => {
    const { transport, say } = await start();
    await say('!merge');
    await say('!perfil');
    await say('Ana');
    await say('ajuda');
    expect(sentTexts(transport)).toEqual([
      'PDF adicionado (2).',
      'Qual o nome, você?',
      'Salvo: Ana',
      'Use !sticker respondendo uma imagem',
    ]);
  });

  it('a sobrescrita da config controla onde os valores entram', async () => {
    const { transport, say } = await start({
      BRIDGER_MIDIA__MESSAGES__ADICIONADO:
        '{count} PDF(s) na fila; {prefix}merge de novo para juntar',
    });
    await say('!merge');
    expect(sentTexts(transport)).toEqual(['2 PDF(s) na fila; !merge de novo para juntar']);
  });
});
