import { createTestBot } from '@usebridger/testing';
import { expect, it } from 'vitest';
import { ping } from './ping.ts';

// Teste de fumaça: o mesmo plugin do bot, sem rede e sem WhatsApp.
it('!ping responde pong', async () => {
  const bot = await createTestBot({ plugins: [ping] });

  await bot.receive({ text: '!ping' });

  expect(bot.sent).toContainText('pong');
  await bot.stop();
});
