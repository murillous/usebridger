// M7-8: recursos de plugin pelo ponto `api.resources` (ADR 0134).

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { rolePermissions } from '#auth/permissions.ts';
import { createAuthStore } from '#auth/store.ts';
import { type Bot, createBot } from '#bot/bot.ts';
import { RecordingTransport, recordingLogger } from '#bot/harness.test-support.ts';
import { BotConfigError } from '#config/owners.ts';
import { createHttp } from '#http/server.ts';
import { definePlugin } from '#plugin/define.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { kernelStorage } from '#storage/namespace.ts';
import { pluginApiRoutes } from './plugins.ts';
import { type ApiResource, defineResource, validateResource } from './resources.ts';

const RankRow = z.object({ id: z.string(), name: z.string(), points: z.number() }).meta({
  id: 'RankRow',
});

const rows = [
  { id: 'a', name: 'Ana', points: 10 },
  { id: 'b', name: 'Bia', points: 5 },
  { id: 'c', name: 'Caio', points: 1 },
];

function ranking(seen: unknown[] = []): ApiResource {
  return defineResource({
    id: 'ranking',
    schema: RankRow,
    permissions: { read: 'rank.read', write: 'rank.write' },
    filter: z.object({ min: z.coerce.number().optional() }),
    list: ({ cursor, limit, filter, actor }) => {
      seen.push(actor);
      const from = cursor === undefined ? 0 : Number(cursor);
      const all = rows.filter((r) => filter.min === undefined || r.points >= filter.min);
      const next = from + limit;
      return {
        items: all.slice(from, next),
        ...(next < all.length && { cursor: String(next) }),
      };
    },
    get: ({ id }) => rows.find((r) => r.id === id),
    actions: [
      {
        id: 'reset',
        permission: 'rank.reset',
        input: z.object({ to: z.number().int().min(0) }),
        output: z.object({ points: z.number() }),
        confirm: true,
        run: ({ id, input }) => ({ points: id === 'a' ? input.to : -1 }),
      },
    ],
  });
}

const bots: Bot[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop().catch(() => undefined);
});

async function start(options: { auth?: boolean; resources?: ApiResource[] } = {}) {
  const storage = createMemoryStorage();
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const bot = createBot({
    transport: new RecordingTransport(),
    logger: recordingLogger(),
    storage,
    http,
    ...(options.auth && { api: { auth: {} } }),
    plugins: [
      definePlugin({
        name: 'rank',
        version: '1.0.0',
        engine: '>=0.0.0',
        setup(ctx) {
          for (const resource of options.resources ?? [ranking()]) {
            ctx.services.contribute('api.resources', resource);
          }
        },
      }),
    ],
  });
  bots.push(bot);
  await bot.start();
  const origin = `http://127.0.0.1:${http.port}`;
  const key = async (permissions: string[]) => {
    const { secret } = await createAuthStore(kernelStorage(storage, 'auth')).createApiKey(
      { name: 'k', permissions },
      new Date(),
    );
    return { authorization: `Bearer ${secret}` };
  };
  return { bot, origin, base: `${origin}/api/resources/rank`, key };
}

const send = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

// biome-ignore lint/suspicious/noExplicitAny: spec lida como JSON solto
const spec = async (origin: string): Promise<any> => (await fetch(`${origin}/openapi.json`)).json();

describe('api.resources na spec', () => {
  it('descreve cada operação com schema, permissão e x-resource', async () => {
    const { origin } = await start();
    const doc = await spec(origin);

    const list = doc.paths['/api/resources/rank/ranking'].get;
    expect(list['x-permission']).toBe('rank.read');
    expect(list['x-resource']).toEqual({ plugin: 'rank', resource: 'ranking', operation: 'list' });
    expect(list.responses['200'].content['application/json'].schema.properties.items.items).toEqual(
      { $ref: '#/components/schemas/RankRow' },
    );
    expect(doc.components.schemas.RankRow.properties.points).toEqual({ type: 'number' });
    const action = doc.paths['/api/resources/rank/ranking/{id}/actions/reset'].post;
    expect(action['x-permission']).toBe('rank.reset');
    expect(action['x-resource']).toEqual({
      plugin: 'rank',
      resource: 'ranking',
      operation: 'action',
      action: 'reset',
      confirm: true,
    });
  });

  it('operação ausente não vira rota nem entra na spec', async () => {
    const { origin, base } = await start();
    const doc = await spec(origin);

    expect(Object.keys(doc.paths['/api/resources/rank/ranking'])).toEqual(['get']);
    expect(Object.keys(doc.paths['/api/resources/rank/ranking/{id}'])).toEqual(['get']);
    const res = await send(`${base}/ranking/a`, 'DELETE');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect((await send(`${base}/ranking`, 'POST', { name: 'x' })).status).toBe(404);
  });

  it('a CLI enxerga os recursos sem servidor', async () => {
    const routes = await pluginApiRoutes([
      definePlugin({
        name: 'rank',
        version: '1.0.0',
        engine: '>=0.0.0',
        setup(ctx) {
          ctx.services.contribute('api.resources', ranking());
        },
      }),
    ]);

    expect(routes.map((r) => `${r.operation.method} ${r.path}`)).toEqual([
      'GET /api/resources/rank/ranking',
      'GET /api/resources/rank/ranking/:id',
      'POST /api/resources/rank/ranking/:id/actions/reset',
    ]);
  });
});

describe('api.resources em runtime', () => {
  it('list pagina por cursor e aplica o filtro da query', async () => {
    const { base } = await start();

    const first = await (await fetch(`${base}/ranking?limit=2`)).json();
    expect(first).toEqual({ items: rows.slice(0, 2), cursor: '2' });
    const rest = await (await fetch(`${base}/ranking?limit=2&cursor=2`)).json();
    expect(rest).toEqual({ items: rows.slice(2) });
    const filtered = (await (await fetch(`${base}/ranking?min=5`)).json()) as {
      items: { id: string }[];
    };
    expect(filtered.items.map((r) => r.id)).toEqual(['a', 'b']);
    expect((await fetch(`${base}/ranking?limit=0`)).status).toBe(400);
  });

  it('get devolve o item, e o que não existe é 404', async () => {
    const { base } = await start();

    expect(await (await fetch(`${base}/ranking/b`)).json()).toEqual(rows[1]);
    expect((await fetch(`${base}/ranking/zz`)).status).toBe(404);
  });

  it('ação com input inválido devolve 400; válida, a saída do run', async () => {
    const { base } = await start();

    const bad = await send(`${base}/ranking/a/actions/reset`, 'POST', { to: -1 });
    expect(bad.status).toBe(400);
    const problem = (await bad.json()) as { errors: unknown[] };
    expect(problem.errors).toEqual([expect.objectContaining({ in: 'body', path: 'to' })]);
    const ok = await send(`${base}/ranking/a/actions/reset`, 'POST', { to: 3 });
    expect(await ok.json()).toEqual({ points: 3 });
  });

  it('create, update e delete com as próprias entradas', async () => {
    const items = new Map([['x', { id: 'x', name: 'X', points: 0 }]]);
    const { base } = await start({
      resources: [
        defineResource({
          id: 'times',
          schema: RankRow,
          create: {
            input: z.object({ name: z.string().min(1) }),
            run: ({ input }) => {
              const item = { id: input.name.toLowerCase(), name: input.name, points: 0 };
              items.set(item.id, item);
              return item;
            },
          },
          update: {
            input: z.object({ points: z.number() }),
            run: ({ id, input }) => {
              const item = items.get(id);
              return item && { ...item, points: input.points };
            },
          },
          delete: ({ id }) => items.delete(id),
        }),
      ],
    });

    const created = await send(`${base}/times`, 'POST', { name: 'Y' });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: 'y', name: 'Y', points: 0 });
    expect((await send(`${base}/times`, 'POST', { name: '' })).status).toBe(400);
    expect(await (await send(`${base}/times/x`, 'PATCH', { points: 7 })).json()).toMatchObject({
      points: 7,
    });
    expect((await send(`${base}/times/nada`, 'PATCH', { points: 7 })).status).toBe(404);
    expect(await (await send(`${base}/times/x`, 'DELETE')).json()).toEqual({ id: 'x' });
    expect((await send(`${base}/times/x`, 'DELETE')).status).toBe(404);
  });

  it('o recurso some da API e da spec no disable do plugin', async () => {
    const { origin, base } = await start();
    expect((await fetch(`${base}/ranking`)).status).toBe(200);

    expect((await send(`${origin}/api/plugins/rank/disable`, 'POST')).status).toBe(200);

    expect((await fetch(`${base}/ranking`)).status).toBe(404);
    expect(Object.keys((await spec(origin)).paths)).not.toContain('/api/resources/rank/ranking');
  });
});

describe('api.resources com a auth', () => {
  it('sem a permissão do recurso é 403; com ela, o handler recebe o ator', async () => {
    const seen: unknown[] = [];
    const { base, key } = await start({ auth: true, resources: [ranking(seen)] });

    expect((await fetch(`${base}/ranking`)).status).toBe(401);
    const other = await fetch(`${base}/ranking`, { headers: await key(['logs.read']) });
    expect(other.status).toBe(403);
    expect(((await other.json()) as { detail: string }).detail).toBe(
      'permissão necessária: rank.read',
    );
    const reader = await key(['rank.read']);
    expect((await fetch(`${base}/ranking`, { headers: reader })).status).toBe(200);
    const actor = seen[0] as { kind: string; can(p: string): boolean };
    expect(actor.kind).toBe('key');
    expect(actor.can('rank.read')).toBe(true);
    expect(actor.can('rank.reset')).toBe(false);
    const reset = await send(`${base}/ranking/a/actions/reset`, 'POST', { to: 1 }, reader);
    expect(reset.status).toBe(403);
  });

  it('as permissões do plugin entram no catálogo das API keys', async () => {
    const { origin, key } = await start({ auth: true });
    const admin = await key(['keys.manage', 'rank.read']);

    const ok = await send(
      `${origin}/api/keys`,
      'POST',
      { name: 'leitor', permissions: ['rank.read'] },
      admin,
    );
    expect(ok.status).toBe(201);
    const unknown = await send(
      `${origin}/api/keys`,
      'POST',
      { name: 'x', permissions: ['rank.nada'] },
      admin,
    );
    expect(unknown.status).toBe(400);
  });
});

describe('papéis com permissões de plugin', () => {
  it('owner e admin recebem todas; viewer, só as .read', () => {
    const extra = ['rank.read', 'rank.reset'];

    expect(rolePermissions('admin', extra)).toEqual(expect.arrayContaining(extra));
    expect(rolePermissions('viewer', extra)).toContain('rank.read');
    expect(rolePermissions('viewer', extra)).not.toContain('rank.reset');
  });
});

describe('validateResource', () => {
  const valid = { id: 'r', schema: RankRow, list: () => ({ items: [] }) };
  const bad = (resource: object) => () => validateResource('p', resource as unknown as ApiResource);

  it.each([
    ['id inválido', { ...valid, id: 'Com Espaço' }],
    ['sem schema', { ...valid, schema: {} }],
    ['permissão fora do formato', { ...valid, permissions: { read: 'ler' } }],
    ['filter com cursor', { ...valid, filter: z.object({ cursor: z.string() }) }],
    ['sem operação', { id: 'r', schema: RankRow }],
    ['create sem input', { ...valid, create: { run: () => ({}) } }],
    [
      'ação repetida',
      {
        ...valid,
        actions: [
          { id: 'a', run: () => undefined },
          { id: 'a', run: () => undefined },
        ],
      },
    ],
  ])('recusa: %s', (_, resource) => {
    expect(bad(resource)).toThrow(BotConfigError);
  });

  it('aceita o recurso mínimo', () => {
    expect(bad(valid)).not.toThrow();
  });

  it('recurso inválido falha o setup do plugin', async () => {
    const bot = createBot({
      transport: new RecordingTransport(),
      logger: recordingLogger(),
      http: createHttp({ port: 0, hostname: '127.0.0.1' }),
      plugins: [
        definePlugin({
          name: 'rank',
          version: '1.0.0',
          engine: '>=0.0.0',
          setup(ctx) {
            ctx.services.contribute('api.resources', { id: 'x' } as unknown as ApiResource);
          },
        }),
      ],
    });
    bots.push(bot);

    await expect(bot.start()).rejects.toThrow(/api.resources "x" sem schema Zod/);
  });
});
