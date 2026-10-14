// `onExpire` pelo kit (ADR 0097): o autor de plugin vence a espera com os fake timers do Vitest
// e espera o bot assentar, sem API nova no `TestBot`.

import { command, definePlugin } from '@usebridger/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestBot, type TestBot } from './test-bot.ts';
// Registra os matchers, como o import do pacote faz para o autor de plugin.
import './matchers.ts';

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

describe('TestBot: onExpire do passo', () => {
  it('a espera vencida com advanceTimersByTimeAsync roda o onExpire', async () => {
    const cadastro = definePlugin({
      name: 'cadastro',
      version: '1.0.0',
      engine: '>=0.0.0',
      setup(ctx) {
        ctx.commands.add(
          command({
            name: 'cadastro',
            run: async (c) => {
              await c.reply('Qual o seu nome?');
              c.expectReply('nome', { ttlMs: 60_000 });
            },
          }),
        );
        ctx.conversations.define('nome', (c) => c.reply(`Olá, ${c.text}`), {
          onExpire: (c) => c.reply('Encerrei por falta de resposta.'),
        });
      },
    });
    const bot = await createTestBot({ plugins: [cadastro] });
    bots.push(bot);

    await bot.receive({ text: '!cadastro' });
    await vi.advanceTimersByTimeAsync(60_000);
    await bot.bot.settled();

    expect(bot.sent).toContainText('Encerrei por falta de resposta.');
  });
});
