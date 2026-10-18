import {
  createHttp,
  definePlugin,
  type HttpHandler,
  type Logger,
  type PluginAdmin,
  PluginHostStateError,
} from '@usebridger/core';
import { createTestBot } from '@usebridger/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { dashboard } from './index.ts';
import { registerPluginRoutes } from './plugins.ts';

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

// Falha no setup (quando a flag liga) com `cause` sensível, e teardown que sempre lança.
const flag = { fail: false, teardown: false };
const fragil = definePlugin({
  name: 'fragil',
  version: '1.0.0',
  engine: '<1.0.0',
  setup() {
    if (flag.fail) throw new Error('x', { cause: { segredo: 'abc' } });
  },
  teardown() {
    if (!flag.teardown) return;
    throw new Error('teardown', { cause: { segredo: 'abc' } });
  },
});

async function start(admin: boolean) {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const bot = await createTestBot({
    plugins: [dashboard, base, filho, fragil],
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
      ['fragil', 'loaded'],
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

describe('serialização segura e erros', () => {
  it('setup-failed e teardownErrors saem sem cause nem segredo', async () => {
    try {
      const { post, get } = await start(true);
      flag.fail = true;
      flag.teardown = true;
      const res = await post('/api/plugins/fragil/reload');
      flag.teardown = false;
      const text = await res.text();
      expect(text).not.toContain('segredo');
      const body = JSON.parse(text) as {
        plugin: { reason: { error: object } };
        teardownErrors: object[];
      };
      expect(Object.keys(body.plugin.reason.error).sort()).toEqual([
        'message',
        'phase',
        'plugin',
        'timedOut',
      ]);
      expect(body.teardownErrors).toHaveLength(1);
      expect(Object.keys(body.teardownErrors[0] ?? {}).sort()).toEqual([
        'message',
        'phase',
        'plugin',
        'timedOut',
      ]);
      const table = await (await get('/api/plugins')).text();
      expect(table).not.toContain('segredo');
      expect(table).toContain('setup-failed');
    } finally {
      flag.fail = false;
      flag.teardown = false;
    }
  });

  // Stub do admin: cobre erros que o host real não produz.
  function stub(error: unknown) {
    const handlers = new Map<string, HttpHandler>();
    const errors: unknown[][] = [];
    const entry = { name: 'x', version: '1', origin: 'config', status: 'loaded' } as const;
    const plugins = Object.assign(() => [entry], {
      reload: () => Promise.reject(error),
      disable: () => Promise.reject(error),
      enable: () => Promise.reject(error),
    });
    registerPluginRoutes(
      { route: (m, path, h) => void handlers.set(`${m} ${path}`, h) },
      { plugins, config: {} } as unknown as PluginAdmin,
      {
        warn: () => undefined,
        error: (...a: unknown[]) => void errors.push(a),
      } as unknown as Logger,
      (h) => h,
    );
    const call = (): Response | Promise<Response> =>
      (handlers.get('POST /api/plugins/:name/reload') as HttpHandler)(
        new Request('http://h/x', { method: 'POST' }),
        { params: { name: 'x' } },
      );
    return { call, errors };
  }

  it('erro que não é de estado dá 500 genérico e é logado', async () => {
    const { call, errors } = stub(new Error('boom'));
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('erro interno');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[1]).toMatchObject({ error: { message: 'boom' } });
  });

  it('409 trunca a mensagem em 300 caracteres', async () => {
    const res = await stub(new PluginHostStateError('a'.repeat(500))).call();
    expect(res.status).toBe(409);
    expect(await res.text()).toHaveLength(300);
  });
});

describe('campos do core na tabela (M5-4.7)', () => {
  it('dependsOn sai na linha, carregada ou ignorada', async () => {
    const { post, get } = await start(true);
    type Row = { name: string; dependsOn?: Record<string, string> };
    const find = async () =>
      ((await (await get('/api/plugins')).json()) as Row[]).find((e) => e.name === 'filho');
    expect((await find())?.dependsOn).toEqual({ base: '*' });
    await post('/api/plugins/base/disable');
    expect((await find())?.dependsOn).toEqual({ base: '*' });
  });
});
