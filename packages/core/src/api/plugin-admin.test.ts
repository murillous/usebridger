// M7-6: plugins e config pela API, com os segredos cifrados (ADR 0117) e escrita auditada.

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AuditEvent } from '#audit/types.ts';
import { createAuthStore } from '#auth/store.ts';
import { type Bot, createBot } from '#bot/bot.ts';
import { RecordingTransport, recordingLogger } from '#bot/harness.test-support.ts';
import { BotConfigError } from '#config/owners.ts';
import { SECRET_MASK, secret } from '#config/schema.ts';
import { createHttp, sessionHttp } from '#http/server.ts';
import { createNoopLogger } from '#logger/logger.ts';
import { definePlugin } from '#plugin/define.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { kernelStorage } from '#storage/namespace.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const VALUE = 'valor-secreto-12345';
const NEW_VALUE = 'outro-segredo-67890';

const bots: Bot[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop().catch(() => undefined);
});

async function start(options: { auth?: boolean; env?: Record<string, string> } = {}) {
  const inner = createMemoryStorage();
  // O stop fecha o storage; o teste lê a auditoria depois dele.
  const storage = { ...inner, close: async () => undefined };
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const seen: unknown[] = [];
  const bot = createBot({
    transport: new RecordingTransport(),
    logger: recordingLogger(),
    env: { BRIDGER_SECRET_KEY: KEY, ...options.env },
    storage,
    http,
    ...(options.auth && { api: { auth: {} } }),
    plugins: [
      definePlugin({
        name: 'p',
        version: '1.2.3',
        engine: '>=0.0.0',
        config: z.object({
          label: z.string().default('a'),
          openai: z.object({ apiKey: secret(z.string().min(8)) }).optional(),
        }),
        setup(ctx) {
          seen.push(ctx.config);
          // A porta só abre com rota de plugin ou transport (ADR 0072).
          ctx.http.route('GET', '/ping', () => new Response('pong'));
        },
      }),
      definePlugin({
        name: 'child',
        version: '1.0.0',
        engine: '>=0.0.0',
        dependsOn: { p: '^1.0.0' },
        setup() {
          // Só existe para depender de `p`.
        },
      }),
    ],
  });
  bots.push(bot);
  await bot.start();
  const base = `http://127.0.0.1:${http.port}/api`;
  const key = async (permissions: string[]) => {
    const { secret: token } = await createAuthStore(kernelStorage(storage, 'auth')).createApiKey(
      { name: 'k', permissions },
      new Date(),
    );
    return { authorization: `Bearer ${token}` };
  };
  const audit = async (): Promise<AuditEvent[]> =>
    (await storage
      .forNamespace('$audit')
      .collection('audit')
      .find({ orderBy: 'seq' })) as unknown as AuditEvent[];
  return { bot, base, key, audit, seen };
}

const send = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

describe('GET /plugins', () => {
  it('lista nome, versão, estado e dependências', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/plugins`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bootedAt: number; plugins: unknown[] };
    expect(body.bootedAt).toEqual(expect.any(Number));
    expect(body.plugins).toEqual([
      expect.objectContaining({ name: 'p', version: '1.2.3', status: 'loaded' }),
      expect.objectContaining({ name: 'child', status: 'loaded', dependsOn: { p: '^1.0.0' } }),
    ]);
  });
});

describe('POST /plugins/{name}/enable e /disable', () => {
  it('desliga e liga o plugin com os dependentes', async () => {
    const { base, bot } = await start();
    const off = await send(`${base}/plugins/p/disable`, 'POST');
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({
      plugin: { name: 'p', status: 'skipped', reason: { kind: 'disabled' } },
      dependents: [{ name: 'child', status: 'skipped', reason: { kind: 'dependency-skipped' } }],
    });
    expect(bot.plugins().find((e) => e.name === 'p')?.status).toBe('skipped');
    const on = await send(`${base}/plugins/p/enable`, 'POST');
    expect(await on.json()).toMatchObject({ plugin: { name: 'p', status: 'loaded' } });
  });

  it('plugin desconhecido é 404 em problem+json', async () => {
    const { base } = await start();
    const res = await send(`${base}/plugins/nada/disable`, 'POST');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect((await fetch(`${base}/plugins/nada/config`)).status).toBe(404);
  });
});

describe('GET /plugins/{name}/config', () => {
  it('segredo nunca sai em claro; JSON Schema junto', async () => {
    const { base } = await start({ env: { BRIDGER_P__OPENAI__API_KEY: VALUE } });
    const res = await fetch(`${base}/plugins/p/config`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(VALUE);
    const body = JSON.parse(text);
    expect(body.view.config).toEqual({ label: 'a', openai: { apiKey: SECRET_MASK } });
    expect(body.schema).toMatchObject({ type: 'object', properties: { label: expect.anything() } });
    expect(body.secretsWritable).toBe(true);
  });
});

describe('PUT /plugins/{name}/config', () => {
  it('grava override e segredo novo; o segredo só volta mascarado', async () => {
    const { base, seen } = await start();
    const res = await send(`${base}/plugins/p/config`, 'PUT', {
      label: 'b',
      openai: { apiKey: VALUE },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(VALUE);
    expect(JSON.parse(text).view.config).toEqual({ label: 'b', openai: { apiKey: SECRET_MASK } });
    expect(seen.at(-1)).toEqual({ label: 'b', openai: { apiKey: VALUE } });
  });

  it('segredo enviado com a máscara mantém o valor', async () => {
    const { base, seen } = await start();
    await send(`${base}/plugins/p/config`, 'PUT', { openai: { apiKey: VALUE } });
    const res = await send(`${base}/plugins/p/config`, 'PUT', {
      label: 'c',
      openai: { apiKey: SECRET_MASK },
    });
    expect(res.status).toBe(200);
    expect(seen.at(-1)).toEqual({ label: 'c', openai: { apiKey: VALUE } });
  });

  it('config inválida devolve problem+json com os caminhos e não muda nada', async () => {
    const { base, seen } = await start();
    const before = seen.length;
    const res = await send(`${base}/plugins/p/config`, 'PUT', {
      label: 5,
      openai: { apiKey: 'curto' },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as { errors: { path: string }[] };
    expect(body.errors.map((e) => e.path)).toEqual(['openai.apiKey']);
    expect(JSON.stringify(body)).not.toContain('curto');
    const label = await send(`${base}/plugins/p/config`, 'PUT', { label: 5 });
    expect(((await label.json()) as { errors: { path: string }[] }).errors).toEqual([
      expect.objectContaining({ in: 'body', path: 'label' }),
    ]);
    expect(seen.length).toBe(before);
  });

  it('campo que o env decide é 409', async () => {
    const { base } = await start({ env: { BRIDGER_P__OPENAI__API_KEY: VALUE } });
    const res = await send(`${base}/plugins/p/config`, 'PUT', { openai: { apiKey: NEW_VALUE } });
    expect(res.status).toBe(409);
  });

  it('escrita auditada pelo ator da requisição, sem o valor do segredo', async () => {
    const { base, key, audit, bot } = await start({ auth: true });
    const headers = await key(['config.write', 'secrets.write', 'plugins.manage']);
    await send(
      `${base}/plugins/p/config`,
      'PUT',
      { label: 'b', openai: { apiKey: VALUE } },
      headers,
    );
    await send(`${base}/plugins/child/disable`, 'POST', undefined, headers);
    await bot.stop();
    const all = await audit();
    const writes = all.filter((e) =>
      ['kernel.config.update', 'kernel.secret.update', 'kernel.plugin.disable'].includes(e.action),
    );
    expect(writes.map((e) => [e.action, e.actor.kind, e.outcome])).toEqual([
      ['kernel.secret.update', 'user', 'success'],
      ['kernel.config.update', 'user', 'success'],
      ['kernel.plugin.disable', 'user', 'success'],
    ]);
    expect(writes[0]?.details).toEqual({ plugin: 'p', path: 'openai.apiKey', op: 'set' });
    expect(JSON.stringify(all)).not.toContain(VALUE);
  });
});

describe('permissões', () => {
  it('403 sem a permissão de cada rota; 401 sem credencial', async () => {
    const { base, key } = await start({ auth: true });
    const viewer = await key(['plugins.read', 'config.read']);
    expect((await fetch(`${base}/plugins`, { headers: viewer })).status).toBe(200);
    expect((await fetch(`${base}/plugins/p/config`, { headers: viewer })).status).toBe(200);
    expect((await send(`${base}/plugins/p/disable`, 'POST', undefined, viewer)).status).toBe(403);
    expect((await send(`${base}/plugins/p/config`, 'PUT', { label: 'b' }, viewer)).status).toBe(
      403,
    );
    const none = await key(['connection.read']);
    expect((await fetch(`${base}/plugins`, { headers: none })).status).toBe(403);
    expect((await fetch(`${base}/plugins/p/config`, { headers: none })).status).toBe(403);
    expect((await fetch(`${base}/plugins`)).status).toBe(401);
  });

  it('segredo novo exige secrets.write; com a máscara, basta config.write', async () => {
    const { base, key, seen } = await start({ auth: true });
    const writer = await key(['config.write']);
    const denied = await send(
      `${base}/plugins/p/config`,
      'PUT',
      { openai: { apiKey: VALUE } },
      writer,
    );
    expect(denied.status).toBe(403);
    expect(seen.at(-1)).toEqual({ label: 'a' });
    const masked = await send(
      `${base}/plugins/p/config`,
      'PUT',
      { label: 'b', openai: { apiKey: SECRET_MASK } },
      writer,
    );
    expect(masked.status).toBe(200);
    expect(seen.at(-1)).toEqual({ label: 'b' });
  });
});

describe('caminhos reservados (ADR 0131)', () => {
  it('operação de plugin em /config, /enable ou /disable lança BotConfigError', () => {
    const session = sessionHttp(
      createHttp({ port: 0, hostname: '127.0.0.1' }),
      'default',
      createNoopLogger,
    );
    const http = session.scope(
      'p',
      () => '/plugins/p',
      () => undefined,
    );
    const operation = { method: 'GET', response: z.object({}), handler: () => ({}) } as const;
    for (const path of ['/config', '/enable/x', '/disable']) {
      expect(() => http.api({ ...operation, path })).toThrow(BotConfigError);
    }
    expect(() => http.api({ ...operation, path: '/configs' })).not.toThrow();
  });
});
