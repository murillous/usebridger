// M7-4 parte 1 (ADR 0127): senha, segredo, papéis, sessão, API key e a guarda das operações.

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { coreApiRoutes } from '#api/core.ts';
import { createOpenApiDocument } from '#api/openapi.ts';
import type { ApiOperation } from '#api/operation.ts';
import type { ProblemBody } from '#api/problem.ts';
import type { Audit } from '#audit/audit.ts';
import { currentAuditSubject } from '#audit/scope.ts';
import type { InternalRecordInput } from '#audit/types.ts';
import { type Bot, createBot } from '#bot/bot.ts';
import { RecordingTransport, recordingLogger } from '#bot/harness.test-support.ts';
import { createHttp, type SessionHttp, sessionHttp } from '#http/server.ts';
import { createNoopLogger } from '#logger/logger.ts';
import { definePlugin } from '#plugin/define.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { kernelStorage } from '#storage/namespace.ts';
import { createActorResolver, SESSION_COOKIE } from './actor.ts';
import { createApiGuard } from './guard.ts';
import { CORE_PERMISSIONS, canManageRole, rolePermissions } from './permissions.ts';
import { hashPassword, hashSecret, verifyPassword, WeakPasswordError } from './secret.ts';
import { type AuthStore, createAuthStore } from './store.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date('2026-10-26T12:00:00Z');

function newStore(): AuthStore {
  return createAuthStore(kernelStorage(createMemoryStorage(), 'auth'));
}

async function newUser(
  store: AuthStore,
  patch: { role?: 'owner' | 'admin' | 'viewer'; status?: 'active' | 'disabled' } = {},
): Promise<string> {
  return store.createUser(
    {
      name: 'Ana',
      email: 'Ana@Exemplo.com',
      passwordHash: 'x',
      role: patch.role ?? 'viewer',
      ...(patch.status && { status: patch.status }),
    },
    T0,
  );
}

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/x', { headers });
}

describe('senha e segredo', () => {
  it('hash com parâmetros no texto, sal por usuário e verificação', async () => {
    const a = await hashPassword('uma senha longa');
    const b = await hashPassword('uma senha longa');
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('uma senha longa', a)).toBe(true);
    expect(await verifyPassword('outra senha longa', a)).toBe(false);
  });

  it('recusa senha menor que 10 caracteres e hash malformado', async () => {
    await expect(hashPassword('curta123')).rejects.toBeInstanceOf(WeakPasswordError);
    expect(await verifyPassword('qualquer coisa', 'lixo')).toBe(false);
    expect(await verifyPassword('qualquer coisa', 'scrypt$3$8$1$YQ$YQ')).toBe(false);
  });

  it('hashSecret é sha256 estável em hex', () => {
    expect(hashSecret('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('papéis', () => {
  it('owner e admin têm tudo; viewer só `.read`', () => {
    expect(rolePermissions('owner')).toEqual(CORE_PERMISSIONS);
    expect(rolePermissions('admin')).toEqual(CORE_PERMISSIONS);
    const viewer = rolePermissions('viewer');
    expect(viewer.length).toBeGreaterThan(0);
    expect(viewer.every((p) => p.endsWith('.read'))).toBe(true);
    expect(viewer).not.toContain('secrets.write');
  });

  it('admin não gerencia owner', () => {
    expect(canManageRole('owner', 'owner')).toBe(true);
    expect(canManageRole('admin', 'owner')).toBe(false);
    expect(canManageRole('admin', 'viewer')).toBe(true);
    expect(canManageRole('viewer', 'viewer')).toBe(false);
  });
});

describe('resolução do ator', () => {
  it('cookie de sessão válido vira ator `user` e atualiza lastSeenAt', async () => {
    const store = newStore();
    const userId = await newUser(store, { role: 'admin' });
    const { token, id } = await store.createSession({ userId, maxAgeMs: 7 * DAY }, T0);
    const later = new Date(T0.getTime() + HOUR);
    const resolve = createActorResolver({ store, now: () => later });
    const actor = await resolve(req({ cookie: `a=1; ${SESSION_COOKIE}=${token}` }));
    expect(actor).toMatchObject({ id: userId, kind: 'user', role: 'admin' });
    expect(actor?.permissions).toEqual(CORE_PERMISSIONS);
    expect(await store.findSessionByToken(token)).toMatchObject({
      id,
      lastSeenAt: later.toISOString(),
    });
  });

  it('guarda só o hash do token', async () => {
    const store = newStore();
    const userId = await newUser(store);
    const { token } = await store.createSession({ userId, maxAgeMs: DAY }, T0);
    const found = await store.findSessionByToken(token);
    expect(found?.hash).toBe(hashSecret(token));
    expect(JSON.stringify(found)).not.toContain(token);
  });

  it('sessão vence por inatividade (8 h)', async () => {
    const store = newStore();
    const userId = await newUser(store);
    const { token } = await store.createSession({ userId, maxAgeMs: 7 * DAY }, T0);
    const headers = { cookie: `${SESSION_COOKIE}=${token}` };
    let now = new Date(T0.getTime() + 7 * HOUR);
    const resolve = createActorResolver({ store, now: () => now });
    expect(await resolve(req(headers))).toBeDefined();
    // 7 h + 7 h: cada acesso renova a inatividade...
    now = new Date(now.getTime() + 7 * HOUR);
    expect(await resolve(req(headers))).toBeDefined();
    // ...mas 9 h parado vence.
    now = new Date(now.getTime() + 9 * HOUR);
    expect(await resolve(req(headers))).toBeUndefined();
  });

  it('sessão vence no limite absoluto mesmo em uso contínuo', async () => {
    const store = newStore();
    const userId = await newUser(store);
    const { token } = await store.createSession({ userId, maxAgeMs: 2 * HOUR }, T0);
    const headers = { cookie: `${SESSION_COOKIE}=${token}` };
    let now = new Date(T0.getTime() + HOUR);
    const resolve = createActorResolver({ store, now: () => now });
    expect(await resolve(req(headers))).toBeDefined();
    now = new Date(T0.getTime() + 2 * HOUR);
    expect(await resolve(req(headers))).toBeUndefined();
  });

  it('sessão revogada, de usuário desativado ou desconhecida não resolve', async () => {
    const store = newStore();
    const userId = await newUser(store);
    const resolve = createActorResolver({ store, now: () => T0 });
    const { token, id } = await store.createSession({ userId, maxAgeMs: DAY }, T0);
    const headers = { cookie: `${SESSION_COOKIE}=${token}` };
    expect(await resolve(req(headers))).toBeDefined();
    await store.revokeSession(id, T0);
    expect(await resolve(req(headers))).toBeUndefined();

    const other = await newUser(store, { status: 'disabled' });
    const { token: t2 } = await store.createSession({ userId: other, maxAgeMs: DAY }, T0);
    expect(await resolve(req({ cookie: `${SESSION_COOKIE}=${t2}` }))).toBeUndefined();

    expect(await resolve(req({ cookie: `${SESSION_COOKIE}=desconhecido` }))).toBeUndefined();
    expect(await resolve(req())).toBeUndefined();
  });

  it('revokeUserSessions encerra as sessões abertas do usuário', async () => {
    const store = newStore();
    const userId = await newUser(store);
    const { token } = await store.createSession({ userId, maxAgeMs: DAY }, T0);
    expect(await store.revokeUserSessions(userId, T0)).toBe(1);
    const resolve = createActorResolver({ store, now: () => T0 });
    expect(await resolve(req({ cookie: `${SESSION_COOKIE}=${token}` }))).toBeUndefined();
  });

  it('bearer: chave válida vira ator `key`; revogada e inválida não', async () => {
    const store = newStore();
    const resolve = createActorResolver({ store, now: () => T0 });
    const { secret, id } = await store.createApiKey({ name: 'ci', permissions: ['logs.read'] }, T0);
    const actor = await resolve(req({ authorization: `Bearer ${secret}` }));
    expect(actor).toEqual({ id, kind: 'key', name: 'ci', permissions: ['logs.read'] });
    expect((await store.getApiKey(id))?.lastUsedAt).toBe(T0.toISOString());
    // A chave nunca é guardada em claro.
    expect(JSON.stringify(await store.getApiKey(id))).not.toContain(secret);

    expect(await resolve(req({ authorization: 'Bearer brk_invalida' }))).toBeUndefined();
    await store.revokeApiKey(id, T0);
    expect(await resolve(req({ authorization: `Bearer ${secret}` }))).toBeUndefined();
  });

  it('bearer inválido não cai para o cookie', async () => {
    const store = newStore();
    const userId = await newUser(store);
    const { token } = await store.createSession({ userId, maxAgeMs: DAY }, T0);
    const resolve = createActorResolver({ store, now: () => T0 });
    const headers = { authorization: 'Bearer lixo', cookie: `${SESSION_COOKIE}=${token}` };
    expect(await resolve(req(headers))).toBeUndefined();
  });

  it('e-mail é normalizado para minúsculas na gravação e na busca', async () => {
    const store = newStore();
    const id = await newUser(store);
    expect((await store.findUserByEmail('ANA@exemplo.com'))?.id).toBe(id);
  });
});

describe('operações com permissão', () => {
  const attached: SessionHttp[] = [];
  afterEach(async () => {
    for (const session of attached.splice(0)) await session.detach();
  });

  async function start(operations: ApiOperation[]) {
    const store = newStore();
    const recorded: InternalRecordInput[] = [];
    const audit = {
      record: (input: InternalRecordInput) => recorded.push(input),
    } as unknown as Audit;
    const guard = createApiGuard({ store, audit: () => audit });
    const http = createHttp({ port: 0, hostname: '127.0.0.1' });
    const session = sessionHttp(http, 'default', createNoopLogger, undefined, {}, guard);
    const scope = session.scope(
      'demo',
      () => '/plugins/demo',
      (error) => {
        throw error;
      },
    );
    for (const operation of operations) scope.api(operation);
    session.attach(() => 'running');
    attached.push(session);
    await session.listen();
    return { base: `http://127.0.0.1:${http.port}/api`, store, recorded };
  }

  const secretOp: ApiOperation = {
    method: 'GET',
    path: '/secret',
    permission: 'logs.read',
    response: z.object({ who: z.string(), subject: z.string().optional() }),
    handler: ({ actor }) => {
      const subject = currentAuditSubject()?.actor;
      return {
        who: actor?.id ?? '?',
        ...(subject?.kind === 'user' && { subject: subject.id }),
      };
    },
  };

  it('401 sem ator, 403 sem permissão (auditado) e 200 com permissão', async () => {
    const { base, store, recorded } = await start([secretOp]);

    const anon = await fetch(`${base}/plugins/demo/secret`);
    expect(anon.status).toBe(401);
    expect(anon.headers.get('content-type')).toContain('application/problem+json');
    expect(((await anon.json()) as ProblemBody).status).toBe(401);
    expect(recorded).toHaveLength(0);

    const weak = await store.createApiKey({ name: 'fraca', permissions: ['metrics.read'] }, T0);
    const denied = await fetch(`${base}/plugins/demo/secret`, {
      headers: { authorization: `Bearer ${weak.secret}` },
    });
    expect(denied.status).toBe(403);
    expect(recorded).toEqual([
      expect.objectContaining({
        action: 'kernel.auth.denied',
        outcome: 'denied',
        target: { type: 'operation', id: 'GET /secret' },
        details: { permission: 'logs.read' },
      }),
    ]);

    const ok = await store.createApiKey({ name: 'forte', permissions: ['logs.read'] }, new Date());
    const res = await fetch(`${base}/plugins/demo/secret`, {
      headers: { authorization: `Bearer ${ok.secret}` },
    });
    expect(res.status).toBe(200);
    // O handler vê o ator e a auditoria dentro dele sai com ele como titular.
    expect(await res.json()).toEqual({ who: ok.id, subject: `key:${ok.id}` });
  });

  it('403 com cookie de viewer em operação de `manage`', async () => {
    const op: ApiOperation = { ...secretOp, path: '/manage', permission: 'plugins.manage' };
    const { base, store, recorded } = await start([op]);
    const userId = await newUser(store, { role: 'viewer' });
    const { token } = await store.createSession({ userId, maxAgeMs: DAY }, new Date());
    const res = await fetch(`${base}/plugins/demo/manage`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.status).toBe(403);
    expect(recorded[0]?.target).toEqual({ type: 'operation', id: 'GET /manage' });
  });

  it('sem `permission` basta estar autenticado; `public` dispensa', async () => {
    const open: ApiOperation = {
      method: 'GET',
      path: '/any',
      response: z.object({}),
      handler: () => ({}),
    };
    const pub: ApiOperation = { ...open, path: '/pub', public: true };
    const { base, store } = await start([open, pub]);
    expect((await fetch(`${base}/plugins/demo/any`)).status).toBe(401);
    expect((await fetch(`${base}/plugins/demo/pub`)).status).toBe(200);
    const key = await store.createApiKey({ name: 'k', permissions: [] }, new Date());
    const res = await fetch(`${base}/plugins/demo/any`, {
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(res.status).toBe(200);
  });
});

describe('spec OpenAPI', () => {
  it('traz securitySchemes, security e x-permission', async () => {
    const op: ApiOperation = {
      method: 'GET',
      path: '/logs',
      permission: 'logs.read',
      response: z.object({}),
      handler: () => ({}),
    };
    const doc = (await createOpenApiDocument([
      ...(await coreApiRoutes()),
      { path: '/api/logs', operation: op },
    ])) as unknown as {
      paths: Record<string, { get: Record<string, unknown> }>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(Object.keys(doc.components.securitySchemes)).toEqual(['cookieAuth', 'bearerAuth']);
    expect(doc.paths['/api/logs']?.get).toMatchObject({
      'x-permission': 'logs.read',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    });
    expect(doc.paths['/api/health']?.get['security']).toEqual([]);
  });
});

describe('configuração', () => {
  const attached: SessionHttp[] = [];
  const bots: Bot[] = [];
  afterEach(async () => {
    for (const bot of bots.splice(0)) await bot.stop();
    for (const session of attached.splice(0)) await session.detach();
  });

  it('recusa api.auth com valores inválidos', () => {
    const http = createHttp({ port: 0 });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '8h' as unknown as number]) {
      expect(() =>
        sessionHttp(http, 'default', createNoopLogger, undefined, { auth: { sessionIdleMs: bad } }),
      ).toThrow(/api\.auth\.sessionIdleMs/);
      expect(() =>
        sessionHttp(http, 'default', createNoopLogger, undefined, {
          auth: { sessionMaxAgeMs: bad },
        }),
      ).toThrow(/api\.auth\.sessionMaxAgeMs/);
    }
    expect(() =>
      sessionHttp(http, 'default', createNoopLogger, undefined, { auth: {} }),
    ).not.toThrow();
  });

  it('recusa permissão fora do formato <área>.<ação> ao registrar', () => {
    const http = createHttp({ port: 0 });
    const session = sessionHttp(http, 'default', createNoopLogger);
    const scope = session.scope(
      'demo',
      () => '/plugins/demo',
      () => undefined,
    );
    const op = { method: 'GET', path: '/x', response: z.object({}), handler: () => ({}) } as const;
    for (const bad of ['logs', 'Logs.Read', 'logs.', '.read', 'a.b.c', '']) {
      expect(() => scope.api({ ...op, permission: bad })).toThrow(/formato <área>\.<ação>/);
    }
    expect(() => scope.api({ ...op, permission: 'auth.on-behalf-of' })).not.toThrow();
  });

  it('createBot com api.auth liga a guarda: 401 sem ator', async () => {
    const plugin = definePlugin({
      name: 'demo',
      version: '1.0.0',
      engine: '>=0.0.0',
      setup(ctx) {
        ctx.http.api({
          method: 'GET',
          path: '/logs',
          permission: 'logs.read',
          response: z.object({}),
          handler: () => ({}),
        });
      },
    });
    const http = createHttp({ port: 0, hostname: '127.0.0.1' });
    const bot = createBot({
      transport: new RecordingTransport(),
      logger: recordingLogger(),
      outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
      env: {},
      http,
      api: { auth: {} },
      plugins: [plugin],
    });
    bots.push(bot);
    await bot.start();
    const res = await fetch(`http://127.0.0.1:${http.port}/api/plugins/demo/logs`);
    expect(res.status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${http.port}/api/health`)).status).toBe(200);
  });
});
