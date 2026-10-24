import {
  ContextExpiredError,
  createHttp,
  definePlugin,
  type HttpHandler,
  type PluginContext,
  secret,
} from '@usebridger/core';
import { z } from '@usebridger/core/zod';
import { createTestBot } from '@usebridger/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { registerConfigRoutes } from './config.ts';
import { dashboard } from './index.ts';

const TOKEN = 'segredo-do-painel';
const API_KEY = 'chave-real-nunca-sai';
const bots: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  Object.assign(flags, { broken: false, boom: false, failLifecycle: false });
  for (const bot of bots.splice(0)) await bot.stop();
});

const target = definePlugin({
  name: 'target',
  version: '1.0.0',
  engine: '<1.0.0',
  config: z.object({
    greeting: z.string().min(2).default('oi'),
    apiKey: secret(z.string()),
  }),
  setup() {
    // Sem efeito: o teste só olha a config.
  },
});

// Estado mutável para provocar falhas depois do boot.
const flags = { broken: false, boom: false, failLifecycle: false };
const flaky = definePlugin({
  name: 'flaky',
  version: '1.0.0',
  engine: '<1.0.0',
  config: z.object({
    mode: z
      .string()
      .default('a')
      .refine(() => !flags.broken, 'config quebrada')
      .transform((value) => {
        if (flags.boom) throw new RangeError('boom interno');
        return value;
      }),
    pass: secret(z.string().default('padrao-secreto-xyz')),
  }),
  setup() {
    if (flags.failLifecycle) throw new Error('setup falhou segredo', { cause: new Error('causa') });
  },
  teardown() {
    if (flags.failLifecycle) throw new Error('teardown falhou');
  },
});

async function start(admin = true) {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const bot = await createTestBot({
    plugins: [dashboard, target, flaky],
    http,
    logLevel: 'info',
    ...(admin ? { adminPlugins: ['dashboard'] } : {}),
    pluginConfig: { dashboard: { token: TOKEN }, target: { apiKey: API_KEY } },
  });
  bots.push(bot);
  const base = `http://127.0.0.1:${http.port}/plugins/dashboard`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const get = (plugin: string) => fetch(`${base}/api/config/${plugin}`, { headers: { cookie } });
  const put = (plugin: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/config/${plugin}`, {
      method: 'PUT',
      headers: { cookie, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { base, cookie, get, put };
}

async function greeting(get: (plugin: string) => Promise<Response>): Promise<string> {
  const body = (await (await get('target')).json()) as { view: { config: { greeting: string } } };
  return body.view.config.greeting;
}

describe('GET /api/config/:plugin', () => {
  it('devolve view e schema, com o secret só mascarado', async () => {
    const { get } = await start();
    const res = await get('target');
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(API_KEY);
    const body = JSON.parse(raw);
    expect(body.view.config.greeting).toBe('oi');
    expect(body.view.config.apiKey).not.toBe(API_KEY);
    expect(body.schema.properties.greeting).toBeDefined();
  });

  it('plugin desconhecido dá 404 e sem cookie dá 401', async () => {
    const { get, base } = await start();
    expect((await get('nao-existe')).status).toBe(404);
    expect((await fetch(`${base}/api/config/target`)).status).toBe(401);
  });
});

describe('PUT /api/config/:plugin', () => {
  it('grava o override, recarrega e a view reflete', async () => {
    const { put, get } = await start();
    const res = await put('target', { greeting: 'olá' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugin: { name: string; status: string } };
    expect(body.plugin.name).toBe('target');
    expect(body.plugin.status).toBe('loaded');
    expect(await greeting(get)).toBe('olá');
  });

  it('config inválida dá 400 com path e message, e nada é salvo', async () => {
    const { put, get } = await start();
    const res = await put('target', { greeting: 'x' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown };
    expect(body.error).toBe('invalid');
    expect(body.issues).toEqual([{ path: 'greeting', message: expect.any(String) }]);
    expect(await greeting(get)).toBe('oi');
  });

  it('campo secret dá 400 com o motivo', async () => {
    const { put } = await start();
    const res = await put('target', { apiKey: 'outra' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: string }[] };
    expect(body.error).toBe('secret');
    expect(body.issues[0]?.path).toBe('apiKey');
    expect(JSON.stringify(body)).not.toContain('outra');
  });

  it('o próprio dashboard dá 409', async () => {
    const { put } = await start();
    const res = await put('dashboard', { logBufferSize: 10 });
    expect(res.status).toBe(409);
    const msg = await res.text();
    expect(msg).toContain('não altera a própria config');
    expect(msg).not.toContain('reload falhou');
  });

  it('plugin desconhecido 404, JSON inválido e não-objeto 400', async () => {
    const { put } = await start();
    expect((await put('nao-existe', {})).status).toBe(404);
    expect((await put('target', '{nope')).status).toBe(400);
    expect((await put('target', '[]')).status).toBe(400);
  });

  it('corpo acima de 64 KiB dá 413', async () => {
    const { put } = await start();
    expect((await put('target', { greeting: 'a'.repeat(70 * 1024) })).status).toBe(413);
  });

  it('origem diferente dá 403', async () => {
    const { put } = await start();
    expect((await put('target', {}, { origin: 'http://evil.example' })).status).toBe(403);
  });
});

describe('sem adminPlugins', () => {
  it('as rotas dão 503 e o resto segue', async () => {
    const { get, put, base, cookie } = await start(false);
    const res = await get('target');
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('adminPlugins');
    expect((await put('target', {})).status).toBe(503);
    expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(200);
  });
});

describe('casos de falha', () => {
  it('GET com a config atual inválida dá 200 com view null, schema e issues', async () => {
    const { get } = await start();
    flags.broken = true;
    const res = await get('flaky');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      view: unknown;
      schema: unknown;
      issues: { path: string }[];
    };
    expect(body.view).toBeNull();
    expect(body.schema).toBeTruthy();
    expect(body.issues[0]?.path).toBe('mode');
  });

  it('erro inesperado (RangeError de transform) dá 500 registrado, não 404', async () => {
    const { put, base, cookie } = await start();
    flags.boom = true;
    const res = await put('flaky', { mode: 'b' });
    expect(res.status).toBe(500);
    const logs = (await (
      await fetch(`${base}/api/logs?level=error`, { headers: { cookie } })
    ).json()) as {
      fields: Record<string, unknown>;
    }[];
    expect(
      logs.some(
        (l) => l.fields['event'] === 'dashboard.config.failed' && l.fields['action'] === 'gravar',
      ),
    ).toBe(true);
  });

  it('falhas de setup/teardown saem só no formato combinado, sem stack nem cause', async () => {
    const { put } = await start();
    flags.failLifecycle = true;
    const res = await put('flaky', { mode: 'c' });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('"stack"');
    expect(raw).not.toContain('"cause"');
    const body = JSON.parse(raw) as {
      plugin: { status: string; reason: { error: Record<string, unknown> } };
      teardownErrors: Record<string, unknown>[];
    };
    const keys = ['message', 'phase', 'plugin', 'timedOut'];
    expect(body.plugin.status).toBe('skipped');
    expect(Object.keys(body.plugin.reason.error).sort()).toEqual(keys);
    expect(body.teardownErrors).toHaveLength(1);
    expect(Object.keys(body.teardownErrors[0] ?? {}).sort()).toEqual(keys);
  });

  it('413 no corte do streaming, sem content-length', async () => {
    const { base, cookie } = await start();
    const chunk = new TextEncoder().encode('x'.repeat(16 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 6) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const res = await fetch(`${base}/api/config/target`, {
      method: 'PUT',
      headers: { cookie },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
  });

  it('o JSON Schema não vaza o default de um campo secret', async () => {
    const { get } = await start();
    expect(await (await get('flaky')).text()).not.toContain('padrao-secreto-xyz');
  });
});

describe('ctx.admin com falha', () => {
  // Contexto falso: só o que `registerConfigRoutes` usa.
  function fake(setOverrides: () => Promise<never>) {
    const routes = new Map<string, HttpHandler>();
    const errors: unknown[][] = [];
    const ctx = {
      plugin: { name: 'dashboard' },
      log: { event: (...args: unknown[]) => errors.push(args) },
      http: { route: (m: string, p: string, h: HttpHandler) => routes.set(`${m} ${p}`, h) },
      admin: {
        plugins: () => [{ name: 'target' }],
        config: { setOverrides },
      },
    } as unknown as PluginContext;
    registerConfigRoutes(ctx, (h) => h);
    const put = () =>
      routes.get('PUT /api/config/:plugin')?.(
        new Request('http://x/', { method: 'PUT', body: '{}' }),
        {
          params: { plugin: 'target' },
        },
      ) as Promise<Response>;
    return { put, errors };
  }

  it('ContextExpiredError dá 503 sem aviso de salvo e sem log de erro', async () => {
    const { put, errors } = fake(() =>
      Promise.reject(
        new ContextExpiredError(
          'dashboard',
          'config.setOverrides',
          'contexto do plugin',
          undefined,
        ),
      ),
    );
    const res = await put();
    expect(res.status).toBe(503);
    const msg = await res.text();
    expect(msg).toContain('tente de novo');
    expect(msg).not.toContain('salv');
    expect(errors).toHaveLength(0);
  });

  it('erro qualquer dá 500 e o log recebe o erro inteiro', async () => {
    const boom = new Error('boom');
    const { put, errors } = fake(() => Promise.reject(boom));
    expect((await put()).status).toBe(500);
    expect(errors[0]).toEqual([
      expect.objectContaining({ name: 'dashboard.config.failed' }),
      { action: 'gravar', target: 'target', err: boom },
    ]);
  });
});
