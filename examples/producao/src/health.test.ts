import { createHttp } from '@usebridger/core';
import { avisos } from '@usebridger/example-configuracao/avisos';
import { createTestBot } from '@usebridger/testing';
import { expect, it } from 'vitest';

const env = {
  BRIDGER_AVISOS__CHAT: 'grupo@g.us',
  BRIDGER_AVISOS__TOKEN: 'token-de-teste-1234567890',
};

// O `/health` que a página manda o supervisor consultar: 200 com o bot de pé, sem nada depois.
it('/health responde 200 com o bot rodando', async () => {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const bot = await createTestBot({ plugins: [avisos], http, env });
  const porta = http.port;

  const resposta = await fetch(`http://127.0.0.1:${porta}/health`);

  expect(resposta.status).toBe(200);
  expect(await resposta.json()).toEqual({ status: 'ok', sessions: { default: 'running' } });
  await bot.stop();
  await expect(fetch(`http://127.0.0.1:${porta}/health`)).rejects.toThrow();
});
