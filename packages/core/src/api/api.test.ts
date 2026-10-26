// M7-3 (ADR 0125): operações da API sob /api, problem+json, /openapi.json, CORS e snapshot da spec.

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type Bot, type BotConfig, createBot } from '#bot/bot.ts';
import { RecordingTransport, recordingLogger } from '#bot/harness.test-support.ts';
import { BotConfigError } from '#config/owners.ts';
import { createHttp, type SessionHttp, sessionHttp } from '#http/server.ts';
import { createNoopLogger } from '#logger/logger.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext, PluginDefinition } from '#plugin/types.ts';
import { coreApiRoutes } from './core.ts';
import type { ApiOptions } from './cors.ts';
import { createOpenApiDocument } from './openapi.ts';
import { ApiError, type ProblemBody } from './problem.ts';

interface Doc {
  openapi: string;
  paths: Record<string, unknown>;
  components: { schemas: Record<string, unknown> };
}

type Scope = ReturnType<SessionHttp['scope']>;

const attached: SessionHttp[] = [];
afterEach(async () => {
  for (const session of attached.splice(0)) await session.detach();
});

async function start(
  options: { session?: string; api?: ApiOptions; errors?: unknown[] } = {},
  register: (api: Scope) => void = () => undefined,
): Promise<string> {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const name = options.session ?? 'default';
  const session = sessionHttp(http, name, createNoopLogger, undefined, options.api);
  register(
    session.scope(
      'demo',
      () => '/plugins/demo',
      (error) => options.errors?.push(error),
    ),
  );
  session.attach(() => 'running');
  attached.push(session);
  await session.listen();
  return `http://127.0.0.1:${http.port}`;
}

function demo(api: Scope): void {
  api.api({
    method: 'GET',
    path: '/users/:id',
    params: z.object({ id: z.string().regex(/^\d+$/) }),
    query: z.object({ verbose: z.enum(['0', '1']).default('0') }),
    response: z.object({ id: z.string() }).meta({ id: 'User' }),
    handler: ({ params }) => ({ id: params.id }),
  });
  api.api({
    method: 'POST',
    path: '/echo',
    body: z.object({ text: z.string() }),
    response: z.object({ text: z.string() }),
    status: 201,
    handler: ({ body }) => body,
  });
  api.api({
    method: 'GET',
    path: '/boom',
    response: z.object({}),
    handler: () => {
      throw new Error('segredo interno');
    },
  });
  api.api({
    method: 'GET',
    path: '/missing',
    response: z.object({}),
    handler: () => {
      throw new ApiError(404, 'não existe');
    },
  });
}

describe('API HTTP', () => {
  it('serve o /api/health e a rota do plugin sob /api/plugins/<nome>', async () => {
    const url = await start({}, demo);
    expect(await (await fetch(`${url}/api/health`)).json()).toEqual({
      status: 'ok',
      sessions: { default: 'running' },
    });
    expect(await (await fetch(`${url}/api/plugins/demo/users/7`)).json()).toEqual({ id: '7' });
    const echo = await fetch(`${url}/api/plugins/demo/echo`, {
      method: 'POST',
      body: JSON.stringify({ text: 'oi' }),
    });
    expect(echo.status).toBe(201);
    // O /health do ADR 0072 segue no ar.
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });

  it('fora da sessão default fica sob /sessions/<sessão>/api', async () => {
    const url = await start({ session: 'erp' }, demo);
    expect((await fetch(`${url}/sessions/erp/api/health`)).status).toBe(200);
    expect((await fetch(`${url}/api/health`)).status).toBe(404);
  });

  it('entrada inválida devolve problem+json 400 com os issues e o traceId', async () => {
    const url = await start({}, demo);
    const response = await fetch(`${url}/api/plugins/demo/users/abc?verbose=2`);
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    const body = (await response.json()) as ProblemBody;
    expect(body).toMatchObject({ type: 'about:blank', title: 'Bad Request', status: 400 });
    expect(body.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.errors?.map((e) => `${e.in}:${e.path}`)).toEqual(['path:id', 'query:verbose']);
    const badJson = await fetch(`${url}/api/plugins/demo/echo`, { method: 'POST', body: '{' });
    expect(((await badJson.json()) as ProblemBody).errors?.[0]?.code).toBe('invalid_json');
  });

  it('ApiError vira o status pedido e rota inexistente sob /api vira 404 problem+json', async () => {
    const url = await start({}, demo);
    const missing = await fetch(`${url}/api/plugins/demo/missing`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ detail: 'não existe', title: 'Not Found' });
    const unknown = await fetch(`${url}/api/nada`);
    expect(unknown.headers.get('content-type')).toBe('application/problem+json');
    expect((await fetch(`${url}/fora`)).headers.get('content-type')).not.toContain('problem');
  });

  it('erro interno vira 500 sem stack nem mensagem e vai para o onError', async () => {
    const errors: unknown[] = [];
    const url = await start({ errors }, demo);
    const response = await fetch(`${url}/api/plugins/demo/boom`);
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).not.toContain('segredo');
    expect(text).not.toContain('at ');
    expect(JSON.parse(text)).toMatchObject({ status: 500, title: 'Internal Server Error' });
    expect(errors).toHaveLength(1);
  });

  it('ApiError 500 explícito vai para o onError e não vaza o detail', async () => {
    const errors: unknown[] = [];
    const url = await start({ errors }, (api) =>
      api.api({
        method: 'GET',
        path: '/x',
        response: z.object({}),
        handler: () => {
          throw new ApiError(500, 'detalhe interno');
        },
      }),
    );
    const response = await fetch(`${url}/api/plugins/demo/x`);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('detalhe interno');
    expect(errors).toHaveLength(1);
  });

  it('404 de caminho desconhecido sob /api leva traceId e traceparent', async () => {
    const url = await start({}, demo);
    const response = await fetch(`${url}/api/nada`);
    const body = (await response.json()) as ProblemBody;
    expect(body.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(response.headers.get('traceparent')).toContain(body.traceId as string);
  });

  it('operação repetida lança conflito', () => {
    const http = createHttp({ port: 0, hostname: '127.0.0.1' });
    const scope = sessionHttp(http, 'default', createNoopLogger).scope(
      'd',
      () => '/p',
      () => undefined,
    );
    demo(scope);
    expect(() => demo(scope)).toThrow('já registrada');
  });
});

describe('GET /openapi.json', () => {
  it('lista core e plugin, inclusive rota registrada depois, com o componente Problem', async () => {
    let late: Scope | undefined;
    const url = await start({}, (api) => {
      late = api;
      demo(api);
    });
    await fetch(`${url}/openapi.json`);
    late?.api({ method: 'GET', path: '/tarde', response: z.object({}), handler: () => ({}) });
    const doc = (await (await fetch(`${url}/openapi.json`)).json()) as Doc;
    expect(doc.openapi).toBe('3.2.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/health',
        '/api/plugins/demo/users/{id}',
        '/api/plugins/demo/echo',
        '/api/plugins/demo/tarde',
      ]),
    );
    expect(doc.components.schemas['Problem']).toBeDefined();
    expect(doc.components.schemas['User']).toBeDefined();
  });
});

describe('GET /openapi.json com falha', () => {
  it('schema que o gerador recusa vira 500 problem+json', async () => {
    const url = await start({}, (api) => {
      // Dois schemas distintos com o mesmo id de componente: o createDocument lança.
      api.api({
        method: 'GET',
        path: '/a',
        response: z.object({ a: z.string() }).meta({ id: 'Dup' }),
        handler: () => ({}),
      });
      api.api({
        method: 'GET',
        path: '/b',
        response: z.object({ b: z.number() }).meta({ id: 'Dup' }),
        handler: () => ({}),
      });
    });
    const response = await fetch(`${url}/openapi.json`);
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
  });
});

describe('CORS', () => {
  const origin = 'https://painel.exemplo.com';

  it('desligado por padrão: nenhum header CORS e preflight não é respondido', async () => {
    const url = await start({}, demo);
    const get = await fetch(`${url}/api/health`, { headers: { origin } });
    expect(get.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(`${url}/api/health`, { method: 'OPTIONS', headers: { origin } });
    expect(preflight.status).toBe(404);
  });

  it('ligado: só a origem da allowlist recebe headers e preflight 204', async () => {
    const url = await start({ api: { cors: { origins: [origin] } } }, demo);
    const ok = await fetch(`${url}/api/health`, { headers: { origin } });
    expect(ok.headers.get('access-control-allow-origin')).toBe(origin);
    const other = await fetch(`${url}/api/health`, { headers: { origin: 'https://mal.com' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(`${url}/api/health`, { method: 'OPTIONS', headers: { origin } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    const denied = await fetch(`${url}/api/health`, {
      method: 'OPTIONS',
      headers: { origin: 'https://mal.com' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    // Vary sempre que o CORS está ligado, mesmo para origem negada ou sem Origin.
    expect(other.headers.get('vary')).toContain('Origin');
    expect((await fetch(`${url}/api/health`)).headers.get('vary')).toContain('Origin');
    const spec = await fetch(`${url}/openapi.json`, { headers: { origin } });
    expect(spec.headers.get('access-control-allow-origin')).toBe(origin);
  });

  it('recusa origins que não é lista de strings', () => {
    const http = createHttp({ port: 0, hostname: '127.0.0.1' });
    const bad = { cors: { origins: 'x' } } as unknown as ApiOptions;
    expect(() => sessionHttp(http, 'default', createNoopLogger, undefined, bad)).toThrow(
      BotConfigError,
    );
  });
});

describe('snapshot da spec do core', () => {
  // Spec é contrato (ADR 0125). Mudou de propósito: `pnpm test -- -u` regrava o arquivo; remover
  // ou mudar rota, campo ou enum exige changeset `major` do core.
  it('bate com o snapshot versionado', async () => {
    const doc = await createOpenApiDocument(await coreApiRoutes(), { version: '0.0.0' });
    await expect(`${JSON.stringify(doc, null, 2)}\n`).toMatchFileSnapshot(
      '__snapshots__/openapi.json',
    );
  });
});

describe('ctx.http.api pelo plugin-context', () => {
  const bots: Bot[] = [];
  afterEach(async () => {
    for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
  });

  function capture(): { plugin: PluginDefinition; ctx: () => PluginContext } {
    let captured: PluginContext | undefined;
    const plugin = definePlugin({
      name: 'cap',
      version: '1.0.0',
      engine: '>=0.0.0',
      setup(ctx) {
        captured = ctx;
      },
    });
    return { plugin, ctx: () => captured as PluginContext };
  }

  const operation = {
    method: 'GET',
    path: '/x',
    response: z.object({}),
    handler: () => ({}),
  } as const;

  function bot(config: Partial<BotConfig>): Bot {
    const created = createBot({
      transport: new RecordingTransport(),
      logger: recordingLogger(),
      outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
      env: {},
      ...config,
    });
    bots.push(created);
    return created;
  }

  it('registrar depois do teardown lança', async () => {
    const { plugin, ctx } = capture();
    const created = bot({
      http: createHttp({ port: 0, hostname: '127.0.0.1' }),
      plugins: [plugin],
    });
    await created.start();
    expect(() => ctx().http.api(operation)).not.toThrow();
    await created.stop();
    expect(() => ctx().http.api({ ...operation, path: '/y' })).toThrow();
  });

  it('sem http na config lança BotConfigError e derruba o setup', async () => {
    const plugin = definePlugin({
      name: 'sem-http',
      version: '1.0.0',
      engine: '>=0.0.0',
      setup(ctx) {
        ctx.http.api(operation);
      },
    });
    await expect(bot({ plugins: [plugin] }).start()).rejects.toMatchObject({
      name: 'PluginBootError',
      reason: { kind: 'setup-failed' },
    });
  });
});
