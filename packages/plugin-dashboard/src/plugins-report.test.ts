// Linha de plugins com duração do setup e horário do boot vindos do core (M5-4.8, ADR 0110).
import { createHttp, definePlugin } from '@usebridger/core';
import { createTestBot } from '@usebridger/testing';
import { afterEach, expect, it } from 'vitest';
import { dashboard } from './index.ts';

const TOKEN = 'segredo-do-painel';
const bots: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop();
});

const lento = definePlugin({
  name: 'lento',
  version: '1.0.0',
  engine: '<1.0.0',
  async setup() {
    await new Promise((resolve) => setTimeout(resolve, 30));
  },
});

it('GET /api/plugins/boot responde 503 sem adminPlugins', async () => {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const bot = await createTestBot({
    plugins: [dashboard],
    http,
    logLevel: 'info',
    pluginConfig: { dashboard: { token: TOKEN } },
  });
  bots.push(bot);
  const url = `http://127.0.0.1:${http.port}/plugins/dashboard`;
  const login = await fetch(`${url}/api/login`, {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect((await fetch(`${url}/api/plugins/boot`, { headers: { cookie } })).status).toBe(503);
});

it('GET /api/plugins traz setupMs, e /boot traz o horário do core', async () => {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const before = Date.now();
  const bot = await createTestBot({
    plugins: [dashboard, lento],
    http,
    logLevel: 'info',
    adminPlugins: ['dashboard'],
    pluginConfig: { dashboard: { token: TOKEN } },
  });
  bots.push(bot);
  const url = `http://127.0.0.1:${http.port}/plugins/dashboard`;
  const login = await fetch(`${url}/api/login`, {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const get = (path: string) => fetch(`${url}${path}`, { headers: { cookie } });

  const table = (await (await get('/api/plugins')).json()) as { name: string; setupMs?: number }[];
  expect(table.find((e) => e.name === 'lento')?.setupMs).toBeGreaterThanOrEqual(25);

  const { bootedAt } = (await (await get('/api/plugins/boot')).json()) as { bootedAt: number };
  expect(bootedAt).toBeGreaterThanOrEqual(before);
  expect(bootedAt).toBeLessThanOrEqual(Date.now());
});
