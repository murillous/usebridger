// ADR 0132: pseudônimo de volta ao id pela API, com permissão própria e auditoria.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '#audit/types.ts';
import { rolePermissions } from '#auth/permissions.ts';
import { createAuthStore } from '#auth/store.ts';
import { type Bot, createBot } from '#bot/bot.ts';
import { RecordingTransport, recordingLogger } from '#bot/harness.test-support.ts';
import { createHttp } from '#http/server.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext } from '#plugin/types.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { kernelStorage } from '#storage/namespace.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const ID = '5565999998888@s.whatsapp.net';

const bots: Bot[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop().catch(() => undefined);
});

async function start(env: Record<string, string> = { BRIDGER_SECRET_KEY: KEY }) {
  const inner = createMemoryStorage();
  // O stop fecha o storage; o teste lê a auditoria depois dele.
  const storage = { ...inner, close: async () => undefined };
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  let ctx: PluginContext | undefined;
  const bot = createBot({
    transport: new RecordingTransport(),
    logger: recordingLogger(),
    env,
    storage,
    http,
    api: { auth: {} },
    plugins: [
      definePlugin({
        name: 'p',
        version: '1.0.0',
        engine: '>=0.0.0',
        setup(context) {
          ctx = context;
          // A porta só abre com rota de plugin ou transport (ADR 0072).
          context.http.route('GET', '/ping', () => new Response('pong'));
        },
      }),
    ],
  });
  bots.push(bot);
  await bot.start();
  const base = `http://127.0.0.1:${http.port}/api`;
  const key = async (permissions: readonly string[]) => {
    const { secret } = await createAuthStore(kernelStorage(storage, 'auth')).createApiKey(
      { name: 'k', permissions: [...permissions] },
      new Date(),
    );
    return { authorization: `Bearer ${secret}` };
  };
  const audit = async (): Promise<AuditEvent[]> =>
    (await storage
      .forNamespace('$audit')
      .collection('audit')
      .find({ orderBy: 'seq' })) as unknown as AuditEvent[];
  const pseudonym = (id: string) => (ctx as PluginContext).pseudonym(id);
  return { bot, base, key, audit, pseudonym };
}

describe('GET /pseudonyms/{pseudonym}', () => {
  it('devolve o id de um pseudônimo calculado pelo bot e audita a consulta sem o id', async () => {
    const { bot, base, key, audit, pseudonym } = await start();
    const value = pseudonym(ID);
    const headers = await key(['pseudonyms.resolve']);
    await vi.waitFor(async () => {
      expect((await fetch(`${base}/pseudonyms/${value}`, { headers })).status).toBe(200);
    });
    const res = await fetch(`${base}/pseudonyms/${value}`, { headers });
    expect(await res.json()).toEqual({ pseudonym: value, kind: 'user', id: ID });
    await bot.stop();
    const rows = (await audit()).filter((e) => e.action === 'kernel.pseudonym.resolve');
    expect(rows.at(-1)).toMatchObject({
      actor: { kind: 'user' },
      target: { type: 'pseudonym', id: value },
      outcome: 'success',
      details: { found: true },
    });
    expect(JSON.stringify(rows)).not.toContain('5565999998888');
  });

  it('desconhecido é 404 e também fica na auditoria; formato inválido é 400', async () => {
    const { bot, base, key, audit } = await start();
    const headers = await key(['pseudonyms.resolve']);
    const unknown = 'u_AAAAAAAAAAAAAAAAAAAAAA';
    expect((await fetch(`${base}/pseudonyms/${unknown}`, { headers })).status).toBe(404);
    expect((await fetch(`${base}/pseudonyms/5565999998888`, { headers })).status).toBe(400);
    await bot.stop();
    expect((await audit()).find((e) => e.action === 'kernel.pseudonym.resolve')).toMatchObject({
      outcome: 'error',
      details: { found: false },
    });
  });

  it('exige pseudonyms.resolve, que o viewer não tem', async () => {
    const { base, key, pseudonym } = await start();
    expect(rolePermissions('viewer')).not.toContain('pseudonyms.resolve');
    expect(rolePermissions('admin')).toContain('pseudonyms.resolve');
    const viewer = await key(rolePermissions('viewer'));
    expect((await fetch(`${base}/pseudonyms/${pseudonym(ID)}`, { headers: viewer })).status).toBe(
      403,
    );
  });

  it('sem BRIDGER_SECRET_KEY é 409: o pseudônimo é efêmero', async () => {
    const { base, key, pseudonym } = await start({});
    const headers = await key(['pseudonyms.resolve']);
    expect((await fetch(`${base}/pseudonyms/${pseudonym(ID)}`, { headers })).status).toBe(409);
  });
});
