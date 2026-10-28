import { createHttp } from '@usebridger/core';
import { createTestBot } from '@usebridger/testing';
import { afterEach, expect, it } from 'vitest';
import { dashboard } from './index.ts';

const bots: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop();
});

// O plugin só serve o app (ADR 0125): sem config, sem rota de dados nem auth própria.
// (O conteúdo dos estáticos depende do build do Vite; o handler é coberto em static.test.ts.)
it('sobe sem config e não tem rota de dados: /api do plugin é 404', async () => {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  bots.push(await createTestBot({ plugins: [dashboard], http }));
  const base = `http://127.0.0.1:${http.port}`;

  expect((await fetch(`${base}/plugins/dashboard/api/status`)).status).toBe(404);
  expect((await fetch(`${base}/plugins/dashboard/api/login`, { method: 'POST' })).status).toBe(404);
  const app = await fetch(`${base}/plugins/dashboard/`);
  expect(app.headers.get('content-type')).not.toContain('application/json');
  // Os dados vêm da API do core, na mesma origem.
  expect((await fetch(`${base}/api/connection`)).status).toBe(200);
});
