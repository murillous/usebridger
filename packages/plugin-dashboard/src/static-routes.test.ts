import { createHttp } from '@usebridger/core';
import { createTestBot } from '@usebridger/testing';
import { afterEach, expect, it } from 'vitest';
import { dashboard } from './index.ts';

const bots: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop();
});

// O `/*` do app convive com as rotas `/api/*`: as registradas antes ganham, o resto é do SPA.
// (O conteúdo dos estáticos depende do build do Vite; o handler é coberto em static.test.ts.)
it('o app em /* não atropela /api/*', async () => {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  bots.push(
    await createTestBot({
      plugins: [dashboard],
      http,
      pluginConfig: { dashboard: { token: 'segredo-do-painel' } },
    }),
  );
  const base = `http://127.0.0.1:${http.port}/plugins/dashboard`;

  expect((await fetch(`${base}/api/status`)).status).toBe(401);
  expect((await fetch(`${base}/api/ws`)).status).toBe(426);
  expect((await fetch(`${base}/api/inexistente`)).status).toBe(404);
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    body: JSON.stringify({ token: 'segredo-do-painel' }),
  });
  expect(login.status).toBe(204);
  const res = await fetch(`${base}/`);
  expect(res.headers.get('content-type')).not.toContain('application/json');
});
