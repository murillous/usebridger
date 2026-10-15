import { ping } from '@usebridger/example-primeiro-bot/ping';
import { createTestBot } from '@usebridger/testing';
import { expect, it } from 'vitest';

// Teste de fumaça: o !ping no perfil `web` do kit, sem subir servidor nem navegador.
it('!ping responde pong no web', async () => {
  const bot = await createTestBot({ profile: 'web', plugins: [ping] });

  await bot.receive({ text: '!ping' });

  expect(bot.sent).toContainText('pong');
  await bot.stop();
});
