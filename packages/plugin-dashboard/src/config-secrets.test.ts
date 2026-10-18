import { createHttp, definePlugin, secret } from '@usebridger/core';
import { z } from '@usebridger/core/zod';
import { createTestBot } from '@usebridger/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { dashboard } from './index.ts';

const TOKEN = 'segredo-do-painel';
const NEW_VALUE = 'valor-novo-nunca-ecoa';
const KEY = Buffer.alloc(32, 7).toString('base64');
const bots: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop();
});

const target = definePlugin({
  name: 'target',
  version: '1.0.0',
  engine: '<1.0.0',
  config: z.object({ apiKey: secret(z.string()), other: secret(z.string().optional()) }),
  setup() {
    // Sem efeito: o teste só olha a config.
  },
});

async function start(env: Record<string, string> = { BRIDGER_SECRET_KEY: KEY }) {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const bot = await createTestBot({
    plugins: [dashboard, target],
    http,
    env,
    adminPlugins: ['dashboard'],
    pluginConfig: { dashboard: { token: TOKEN }, target: { apiKey: 'do-arquivo' } },
  });
  bots.push(bot);
  const base = `http://127.0.0.1:${http.port}/plugins/dashboard`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const url = (plugin: string, path: string) => `${base}/api/config/${plugin}/secrets/${path}`;
  const put = (path: string, value: unknown, plugin = 'target', headers = { cookie }) =>
    fetch(url(plugin, path), { method: 'PUT', headers, body: JSON.stringify({ value }) });
  const del = (path: string, plugin = 'target', headers = { cookie }) =>
    fetch(url(plugin, path), { method: 'DELETE', headers });
  const sources = async () =>
    (
      (await (await fetch(`${base}/api/config/target`, { headers: { cookie } })).json()) as {
        view: { sources: Record<string, string> };
      }
    ).view.sources;
  return { base, cookie, put, del, sources };
}

describe('segredos: PUT e DELETE /api/config/:plugin/secrets/:path', () => {
  it('manifesto leva secretsWritable', async () => {
    const { base, cookie } = await start();
    const body = (await (
      await fetch(`${base}/api/config/target`, { headers: { cookie } })
    ).json()) as { secretsWritable: boolean };
    expect(body.secretsWritable).toBe(true);
  });

  it('substitui o segredo sem ecoar o valor e remove depois', async () => {
    const { put, del, sources } = await start();
    // O arquivo define `apiKey`; `other` só existe pelo segredo.
    const res = await put('other', NEW_VALUE);
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(NEW_VALUE);
    expect(JSON.parse(raw).plugin.name).toBe('target');
    expect((await sources())['other']).toBe('secret');

    const gone = await del('other');
    expect(gone.status).toBe(200);
    expect((await sources())['other']).toBeUndefined();
  });

  it('campo sombreado pelo arquivo dá 409 shadowed, sem o valor', async () => {
    const { put } = await start();
    const res = await put('apiKey', NEW_VALUE);
    expect(res.status).toBe(409);
    const raw = await res.text();
    expect(JSON.parse(raw).error).toBe('shadowed');
    expect(raw).not.toContain(NEW_VALUE);
  });

  it('sem chave mestra dá 400 citando BRIDGER_SECRET_KEY, e secretsWritable é falso', async () => {
    const { put, base, cookie } = await start({});
    const res = await put('other', NEW_VALUE);
    expect(res.status).toBe(400);
    const raw = await res.text();
    expect(raw).toContain('BRIDGER_SECRET_KEY');
    expect(raw).not.toContain(NEW_VALUE);
    const body = (await (
      await fetch(`${base}/api/config/target`, { headers: { cookie } })
    ).json()) as { secretsWritable: boolean };
    expect(body.secretsWritable).toBe(false);
  });

  it('corpo sem value, JSON inválido, plugin desconhecido e o próprio dashboard', async () => {
    const { base, cookie, put } = await start();
    const raw = (body: string) =>
      fetch(`${base}/api/config/target/secrets/other`, {
        method: 'PUT',
        headers: { cookie },
        body,
      });
    expect((await raw('{}')).status).toBe(400);
    expect((await raw('{nope')).status).toBe(400);
    expect((await put('other', 'x', 'nao-existe')).status).toBe(404);
    expect((await put('token', 'x', 'dashboard')).status).toBe(409);
  });

  it('exige autenticação e mesma origem', async () => {
    const { put, del, base, cookie } = await start();
    expect((await put('other', 'x', 'target', {} as { cookie: string })).status).toBe(401);
    expect((await del('other', 'target', {} as { cookie: string })).status).toBe(401);
    const cross = await fetch(`${base}/api/config/target/secrets/other`, {
      method: 'DELETE',
      headers: { cookie, origin: 'http://evil.example' },
    });
    expect(cross.status).toBe(403);
  });
});
