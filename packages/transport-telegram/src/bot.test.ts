// O mesmo plugin portátil do Baileys e do web (ver `transport-baileys/src/portable.test.ts`)
// rodando no Telegram pelo `createBot`: comando com `@NomeDoBot` e menu com botões de verdade,
// cujo clique roda o comando (ADR 0058).

import {
  type Bot,
  command,
  createBot,
  createLogger,
  createMemoryStorage,
  definePlugin,
} from '@usebridger/core';
import type { Message as TgMessage } from 'grammy/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeTelegram } from './fake-telegram.test-support.ts';
import { TelegramTransport } from './transport.ts';

const USER = { id: 7, is_bot: false, first_name: 'Ana' };
const CHAT = { id: 7, type: 'private' as const, first_name: 'Ana' };
const bots: Bot[] = [];

afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop();
});

const portable = definePlugin({
  name: 'portatil',
  version: '1.0.0',
  engine: '>=0.0.0',
  setup(ctx) {
    ctx.commands.add(command({ name: 'ping', run: (c) => c.reply('pong') }));
    ctx.commands.add(
      command({
        name: 'menu',
        run: (c) =>
          c.reply('Escolha:', { actions: [{ label: 'Eco', command: 'eco', args: ['clicado'] }] }),
      }),
    );
    ctx.commands.add(command({ name: 'eco', run: (c) => c.reply(`eco ${c.rawArgs}`) }));
  },
});

describe('plugin portátil no Telegram', () => {
  it('/ping@bot responde, e o clique no botão do menu roda o comando', async () => {
    const fake = new FakeTelegram();
    const bot = createBot({
      transport: (deps) => new TelegramTransport(fake.driver, deps),
      storage: createMemoryStorage(),
      logger: createLogger({ level: 'silent' }),
      outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
      env: {},
      prefix: '/',
      plugins: [portable],
    });
    bots.push(bot);
    await bot.start();

    let seq = 0;
    const receive = (text: string) =>
      fake.push({
        message: {
          message_id: ++seq,
          date: 1_760_000_000,
          chat: CHAT,
          from: USER,
          text,
        } as TgMessage,
      });
    const sent = () => fake.callsTo('sendMessage');

    receive('/ping@fake_bot');
    await vi.waitFor(() => expect(sent().map((p) => p['text'])).toEqual(['pong']));
    // O menu nativo saiu no open, com os três comandos.
    expect(fake.callsTo('setMyCommands')[0]?.['commands']).toHaveLength(3);

    receive('/menu');
    await vi.waitFor(() => expect(sent()).toHaveLength(2));
    const keyboard = sent()[1]?.['reply_markup'] as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    const button = keyboard.inline_keyboard[0]?.[0];
    expect(button?.text).toBe('Eco');

    fake.push({
      callback_query: {
        id: 'q1',
        from: USER,
        chat_instance: 'i',
        data: button?.callback_data,
        message: {
          message_id: 1001,
          date: 1_760_000_000,
          chat: CHAT,
          text: 'Escolha:',
        } as TgMessage,
      },
    });
    await vi.waitFor(() => expect(sent().at(-1)?.['text']).toBe('eco clicado'));
    // A resposta ao clique é mensagem nova, sem citar o `callback_query.id`.
    expect(sent().at(-1)).not.toHaveProperty('reply_parameters');
    expect(fake.callsTo('answerCallbackQuery')).toEqual([{ callback_query_id: 'q1' }]);
  });
});
