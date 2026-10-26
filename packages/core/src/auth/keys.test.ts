// M7-4 parte 3 (ADR 0127): rotas de API keys e `X-Bridger-On-Behalf-Of`.

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { coreApiRoutes } from '#api/core.ts';
import { loadApiLibs } from '#api/libs.ts';
import { createOpenApiDocument } from '#api/openapi.ts';
import type { ApiOperation } from '#api/operation.ts';
import type { Audit } from '#audit/audit.ts';
import { currentAuditSubject } from '#audit/scope.ts';
import type { InternalRecordInput } from '#audit/types.ts';
import { createHttp, type SessionHttp, sessionHttp } from '#http/server.ts';
import { createNoopLogger } from '#logger/logger.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { kernelStorage } from '#storage/namespace.ts';
import { SESSION_COOKIE } from './actor.ts';
import { createApiGuard } from './guard.ts';
import { createAuthStore } from './store.ts';

const attached: SessionHttp[] = [];
afterEach(async () => {
  for (const session of attached.splice(0)) await session.detach();
});

const whoami: ApiOperation = {
  method: 'GET',
  path: '/whoami',
  permission: 'logs.read',
  response: z.object({ onBehalfOf: z.string().optional(), subject: z.unknown() }),
  handler: ({ actor }) => ({
    ...(actor?.onBehalfOf !== undefined && { onBehalfOf: actor.onBehalfOf }),
    subject: currentAuditSubject()?.actor,
  }),
};

const WHOAMI = '/plugins/demo/whoami';
const OBO = 'x-bridger-on-behalf-of';

async function start() {
  await loadApiLibs();
  const store = createAuthStore(kernelStorage(createMemoryStorage(), 'auth'));
  const recorded: InternalRecordInput[] = [];
  const audit = {
    record: (input: InternalRecordInput) => recorded.push(input),
  } as unknown as Audit;
  const guard = createApiGuard({ store, audit: () => audit });
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const session = sessionHttp(http, 'default', createNoopLogger, undefined, {}, guard);
  session
    .scope(
      'demo',
      () => '/plugins/demo',
      (error) => {
        throw error;
      },
    )
    .api(whoami);
  session.attach(() => 'running');
  attached.push(session);
  await session.listen();
  const base = `http://127.0.0.1:${http.port}/api`;
  const admin = await store.createApiKey(
    { name: 'admin', permissions: ['keys.manage', 'logs.read', 'auth.on-behalf-of'] },
    new Date(),
  );
  const call = (secret: string, path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
  const create = (secret: string, body: unknown) =>
    call(secret, '/keys', { method: 'POST', body: JSON.stringify(body) });
  return { base, store, recorded, admin, call, create };
}

type Created = { id: string; secret: string };

describe('rotas /api/keys', () => {
  it('mostra o segredo uma vez; a listagem não o traz e o storage guarda só o hash', async () => {
    const { admin, call, create, store, recorded } = await start();
    const res = await create(admin.secret, { name: 'ci', permissions: ['logs.read'] });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Created;
    expect(created.secret).toMatch(/^brk_/);
    expect(JSON.stringify(await store.getApiKey(created.id))).not.toContain(created.secret);

    const list = (await (await call(admin.secret, '/keys')).json()) as {
      keys: { name: string; lastUsedAt: string | null; revokedAt: string | null }[];
    };
    expect(JSON.stringify(list)).not.toContain(created.secret);
    expect(list.keys.map((k) => k.name)).toEqual(['admin', 'ci']);
    expect(list.keys[1]).toMatchObject({ lastUsedAt: null, revokedAt: null });
    expect(recorded).toContainEqual(
      expect.objectContaining({
        action: 'kernel.key.created',
        target: { type: 'api-key', id: created.id },
      }),
    );
  });

  it('escopo: 200 dentro dele, 403 fora; lastUsedAt atualizado', async () => {
    const { admin, call, create } = await start();
    const created = (await (
      await create(admin.secret, { name: 'ci', permissions: ['logs.read'] })
    ).json()) as Created;
    expect((await call(created.secret, WHOAMI)).status).toBe(200);
    expect((await call(created.secret, '/keys')).status).toBe(403);
    const list = (await (await call(admin.secret, '/keys')).json()) as {
      keys: { id: string; lastUsedAt: string | null }[];
    };
    expect(list.keys.find((k) => k.id === created.id)?.lastUsedAt).not.toBeNull();
  });

  it('chave revogada responde 401; revogar é auditado uma vez', async () => {
    const { admin, call, create, recorded } = await start();
    const created = (await (
      await create(admin.secret, { name: 'ci', permissions: ['logs.read'] })
    ).json()) as Created;
    const revoke = (id: string) => call(admin.secret, `/keys/${id}`, { method: 'DELETE' });
    expect((await revoke(created.id)).status).toBe(200);
    expect((await revoke(created.id)).status).toBe(200);
    expect((await revoke('nao-existe')).status).toBe(404);
    expect((await call(created.secret, WHOAMI)).status).toBe(401);
    expect(recorded.filter((e) => e.action === 'kernel.key.revoked')).toHaveLength(1);
    const list = (await (await call(admin.secret, '/keys')).json()) as {
      keys: { id: string; revokedAt: string | null }[];
    };
    expect(list.keys.find((k) => k.id === created.id)?.revokedAt).not.toBeNull();
  });

  it('recusa permissão que o criador não tem (403) e a desconhecida (400)', async () => {
    const { admin, create, store } = await start();
    const manager = await store.createApiKey(
      { name: 'gerente', permissions: ['keys.manage', 'logs.read'] },
      new Date(),
    );
    const status = async (secret: string, name: string, permissions: string[]) =>
      (await create(secret, { name, permissions })).status;
    expect(await status(manager.secret, 'x', ['logs.read'])).toBe(201);
    expect(await status(manager.secret, 'x', ['secrets.write'])).toBe(403);
    expect(await status(admin.secret, 'x', ['inventada.x'])).toBe(400);
    expect(await status(admin.secret, ' ', ['logs.read'])).toBe(400);
  });
});

describe('X-Bridger-On-Behalf-Of', () => {
  it('chave sem a permissão: 403 auditado', async () => {
    const { admin, call, create, recorded } = await start();
    const plain = (await (
      await create(admin.secret, { name: 'bff', permissions: ['logs.read'] })
    ).json()) as Created;
    recorded.length = 0;
    const res = await call(plain.secret, WHOAMI, { headers: { [OBO]: 'user-42' } });
    expect(res.status).toBe(403);
    expect(recorded).toEqual([
      expect.objectContaining({
        action: 'kernel.auth.denied',
        outcome: 'denied',
        details: { permission: 'auth.on-behalf-of' },
      }),
    ]);
  });

  it('sessão de usuário: 403 mesmo sendo owner', async () => {
    const { base, store, recorded } = await start();
    const userId = await store.createUser(
      { name: 'Ana', email: 'a@x.com', passwordHash: 'x', role: 'owner' },
      new Date(),
    );
    const { token } = await store.createSession({ userId, maxAgeMs: 60_000 }, new Date());
    const headers = { cookie: `${SESSION_COOKIE}=${token}` };
    expect((await fetch(`${base}${WHOAMI}`, { headers })).status).toBe(200);
    const res = await fetch(`${base}${WHOAMI}`, { headers: { ...headers, [OBO]: 'user-42' } });
    expect(res.status).toBe(403);
    expect(recorded).toHaveLength(1);
  });

  it('com a permissão: vai para o ator e para o titular da auditoria', async () => {
    const { admin, call } = await start();
    const res = await call(admin.secret, WHOAMI, { headers: { [OBO]: ' user-42 ' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      onBehalfOf: 'user-42',
      subject: { kind: 'user', id: `key:${admin.id}`, name: 'admin', onBehalfOf: 'user-42' },
    });
  });

  it('valor vazio ou longo demais: 400; o escopo da chave continua valendo', async () => {
    const { admin, call } = await start();
    for (const value of ['  ', 'x'.repeat(257)]) {
      expect((await call(admin.secret, WHOAMI, { headers: { [OBO]: value } })).status).toBe(400);
    }
    // Delegar não amplia: `secrets.write` a chave nunca teve.
    const secretOp = await call(admin.secret, '/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', permissions: ['secrets.write'] }),
      headers: { [OBO]: 'user-42' },
    });
    expect(secretOp.status).toBe(403);
  });
});

describe('spec OpenAPI', () => {
  it('as rotas de chaves trazem x-permission', async () => {
    const doc = (await createOpenApiDocument(await coreApiRoutes(true))) as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(doc.paths['/api/keys']?.['post']?.['x-permission']).toBe('keys.manage');
    expect(doc.paths['/api/keys/{id}']?.['delete']?.['x-permission']).toBe('keys.manage');
  });
});
