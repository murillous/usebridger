import { createHttp, definePlugin, secret } from '@usebridger/core';
import { z } from '@usebridger/core/zod';
import { createTestBot } from '@usebridger/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { dashboard } from './index.ts';

const TOKEN = 'segredo-do-painel';
const API_KEY = 'chave-real-nunca-sai';
const bots: { stop(): Promise<void> }[] = [];
afterEach(async () => {
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

async function start(admin = true) {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const bot = await createTestBot({
    plugins: [dashboard, target],
    http,
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
    expect((await put('dashboard', { logBufferSize: 10 })).status).toBe(409);
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
