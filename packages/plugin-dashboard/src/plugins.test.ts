import { createHttp, definePlugin } from '@usebridger/core';
import { createTestBot } from '@usebridger/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { dashboard } from './index.ts';

const TOKEN = 'segredo-do-painel';
const bots: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop();
});

const base = definePlugin({
  name: 'base',
  version: '1.0.0',
  engine: '<1.0.0',
  setup() {
    // Plugin de teste sem comportamento.
  },
});

const filho = definePlugin({
  name: 'filho',
  version: '1.0.0',
  engine: '<1.0.0',
  dependsOn: { base: '*' },
  setup() {
    // Plugin de teste sem comportamento.
  },
});

async function start(admin: boolean) {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const bot = await createTestBot({
    plugins: [dashboard, base, filho],
    http,
    logLevel: 'info',
    ...(admin ? { adminPlugins: ['dashboard'] } : {}),
    pluginConfig: { dashboard: { token: TOKEN } },
  });
  bots.push(bot);
  const url = `http://127.0.0.1:${http.port}/plugins/dashboard`;
  const login = await fetch(`${url}/api/login`, {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const post = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, { method: 'POST', headers: { cookie, ...headers } });
  const get = (path: string) => fetch(`${url}${path}`, { headers: { cookie } });
  return { url, post, get };
}

describe('rotas de plugins', () => {
  it('GET /api/plugins devolve a tabela e exige sessão', async () => {
    const { url, get } = await start(true);
    expect((await fetch(`${url}/api/plugins`)).status).toBe(401);
    const table = (await (await get('/api/plugins')).json()) as { name: string; status: string }[];
    expect(table.map((e) => [e.name, e.status])).toEqual([
      ['dashboard', 'loaded'],
      ['base', 'loaded'],
      ['filho', 'loaded'],
    ]);
  });

  it('disable, enable e reload devolvem o plugin e os dependentes', async () => {
    const { post, get } = await start(true);
    const off = (await (await post('/api/plugins/base/disable')).json()) as {
      plugin: { reason: { kind: string } };
      dependents: { name: string; reason: { kind: string } }[];
      teardownErrors: unknown[];
    };
    expect(off.plugin.reason.kind).toBe('disabled');
    expect(off.dependents.map((d) => [d.name, d.reason.kind])).toEqual([
      ['filho', 'dependency-skipped'],
    ]);
    expect(off.teardownErrors).toEqual([]);

    const on = (await (await post('/api/plugins/base/enable')).json()) as {
      plugin: { status: string };
      dependents: { name: string; status: string }[];
    };
    expect(on.plugin.status).toBe('loaded');
    expect(on.dependents).toMatchObject([{ name: 'filho', status: 'loaded' }]);

    expect((await post('/api/plugins/base/reload')).status).toBe(200);
    const table = (await (await get('/api/plugins')).json()) as { status: string }[];
    expect(table.every((e) => e.status === 'loaded')).toBe(true);
  });

  it('nome desconhecido dá 404; reload/disable do próprio dashboard dá 409', async () => {
    const { post } = await start(true);
    expect((await post('/api/plugins/nada/reload')).status).toBe(404);
    const self = await post('/api/plugins/dashboard/disable');
    expect(self.status).toBe(409);
    expect(await self.text()).toContain('dashboard');
    expect((await post('/api/plugins/dashboard/reload')).status).toBe(409);
  });

  it('reload de plugin desabilitado dá 409', async () => {
    const { post } = await start(true);
    await post('/api/plugins/filho/disable');
    expect((await post('/api/plugins/filho/reload')).status).toBe(409);
  });

  it('POST exige sessão e Origin do mesmo host', async () => {
    const { url, post } = await start(true);
    const semCookie = await fetch(`${url}/api/plugins/base/disable`, { method: 'POST' });
    expect(semCookie.status).toBe(401);
    const outra = await post('/api/plugins/base/disable', { origin: 'http://evil.example' });
    expect(outra.status).toBe(403);
  });

  it('sem adminPlugins responde 503, loga warn uma vez e status/logs seguem', async () => {
    const { post, get } = await start(false);
    const res = await get('/api/plugins');
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('adminPlugins');
    expect((await post('/api/plugins/base/disable')).status).toBe(503);
    expect((await get('/api/status')).status).toBe(200);
    const logs = (await (await get('/api/logs?level=warn')).json()) as { message: string }[];
    expect(logs.filter((l) => l.message.includes('adminPlugins'))).toHaveLength(1);
  });
});
