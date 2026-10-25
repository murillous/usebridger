// Opção A: documento OpenAPI 3.2 montado à mão sobre z.toJSONSchema, rotas registradas em runtime.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
interface RouteSpec {
  method: Method;
  path: string; // formato OpenAPI: /plugins/{name}
  summary: string;
  query?: z.ZodObject;
  body?: z.ZodType;
  response?: z.ZodType;
  sse?: z.ZodType; // item de text/event-stream
}

// Registro próprio: só os schemas com id viram componente.
const registry = z.registry<{ id: string }>();
const routes: RouteSpec[] = [];

const Problem = z
  .object({ type: z.string(), title: z.string(), status: z.number().int(), detail: z.string().optional() })
  .register(registry, { id: 'Problem' });
const Plugin = z
  .object({ name: z.string(), version: z.string(), enabled: z.boolean() })
  .register(registry, { id: 'Plugin' });
const PluginList = z.object({ items: z.array(Plugin), total: z.number().int() });
const LogEvent = z
  .object({ ts: z.string(), level: z.enum(['debug', 'info', 'warn', 'error']), event: z.string(), msg: z.string() })
  .register(registry, { id: 'LogEvent' });

type Handler = Parameters<Hono['get']>[1];
const handlers: Handler[] = [];

// Como o core (http/server.ts): o router do Hono não aceita rota depois do primeiro match, então
// o app é remontado da tabela a cada mudança. A spec lê a mesma tabela.
function build(): Hono {
  const a = new Hono();
  a.use('*', async (c, next) => {
    await next();
    c.header('access-control-allow-origin', '*');
  });
  a.get('/openapi.json', (c) => c.json(buildDocument()));
  routes.forEach((r, i) => a.on(r.method.toUpperCase(), r.path.replace(/\{(\w+)\}/g, ':$1'), handlers[i]));
  return a;
}
let app = build();
export const fetchApp = (req: Request) => app.fetch(req);

// API que um plugin usaria: registra a rota no Hono e na spec ao mesmo tempo.
export function route(spec: RouteSpec, handler: Handler) {
  routes.push(spec);
  handlers.push(handler);
  app = build();
}

export function buildDocument() {
  // z.toJSONSchema(schema) solto vira $defs locais; só a conversão de um registro inteiro emite
  // $ref externo. Então cada schema de rota entra num registro temporário com id sintético e
  // sai de lá já apontando para #/components/schemas.
  const tmp = z.registry<{ id: string }>();
  for (const s of [Problem, Plugin, LogEvent]) tmp.add(s, registry.get(s)!);
  const pending: z.ZodType[] = [];
  const toSchema = (s: z.ZodType) => {
    const meta = registry.get(s);
    if (meta) return { $ref: `#/components/schemas/${meta.id}` };
    pending.push(s);
    tmp.add(s, { id: `__route${pending.length - 1}` });
    return { __pending: pending.length - 1 };
  };
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
    const query = r.query
      ? Object.entries(r.query.shape).map(([name, s]) => ({ name, in: 'query', required: !(s as z.ZodType).safeParse(undefined).success, schema: toSchema(s as z.ZodType) }))
      : [];
    const content = r.sse
      ? { 'text/event-stream': { itemSchema: { type: 'object', required: ['data'], properties: { event: { type: 'string' }, data: { contentMediaType: 'application/json', contentSchema: toSchema(r.sse) } } } } }
      : { 'application/json': { schema: toSchema(r.response ?? z.null()) } };
    paths[r.path] ??= {};
    paths[r.path][r.method] = {
      summary: r.summary,
      parameters: [...params, ...query],
      ...(r.body && { requestBody: { required: true, content: { 'application/json': { schema: toSchema(r.body) } } } }),
      responses: {
        '200': { description: 'OK', content },
        default: { description: 'Erro', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
      },
    };
  }
  const { schemas } = z.toJSONSchema(tmp, { target: 'draft-2020-12', io: 'output', unrepresentable: 'any', uri: (id) => `#/components/schemas/${id}` });
  // Troca os marcadores pelo schema convertido e tira os sintéticos dos componentes.
  const resolve = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object') {
      if ('__pending' in v) {
        const { $id: _id, ...rest } = schemas[`__route${(v as { __pending: number }).__pending}`] as Record<string, unknown>;
        return rest;
      }
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    }
    return v;
  };
  const components = Object.fromEntries(Object.entries(schemas).filter(([id]) => !id.startsWith('__route')));
  return { openapi: '3.2.0', info: { title: 'Bridger', version: '0.0.0-proto' }, paths: resolve(paths), components: { schemas: components } };
}

const plugins = [
  { name: 'metrics', version: '1.0.0', enabled: true },
  { name: 'dashboard', version: '1.0.0', enabled: false },
  { name: 'echo', version: '0.1.0', enabled: true },
];


route(
  { method: 'get', path: '/plugins', summary: 'Lista plugins', query: z.object({ q: z.string().optional(), enabled: z.enum(['true', 'false']).optional() }), response: PluginList },
  (c) => {
    const q = c.req.query('q');
    const enabled = c.req.query('enabled');
    const items = plugins.filter((p) => (!q || p.name.includes(q)) && (!enabled || String(p.enabled) === enabled));
    return c.json({ items, total: items.length });
  },
);
route({ method: 'get', path: '/plugins/{name}', summary: 'Um plugin', response: Plugin }, (c) => {
  const p = plugins.find((x) => x.name === c.req.param('name'));
  return p ? c.json(p) : c.json({ type: 'about:blank', title: 'Not Found', status: 404 }, 404, { 'content-type': 'application/problem+json' });
});
route({ method: 'patch', path: '/plugins/{name}', summary: 'Liga/desliga', body: Plugin.pick({ enabled: true }), response: Plugin }, async (c) => {
  const p = plugins.find((x) => x.name === c.req.param('name'));
  if (!p) return c.json({ type: 'about:blank', title: 'Not Found', status: 404 }, 404);
  Object.assign(p, Plugin.pick({ enabled: true }).parse(await c.req.json()));
  return c.json(p);
});
route({ method: 'get', path: '/logs/stream', summary: 'Logs ao vivo', sse: LogEvent }, (c) =>
  streamSSE(c, async (stream) => {
    for (let i = 0; i < 3; i++) {
      const ev: z.infer<typeof LogEvent> = { ts: new Date().toISOString(), level: 'info', event: 'proto.tick', msg: `tick ${i}` };
      await stream.writeSSE({ event: 'log', id: String(i), data: JSON.stringify(ev) });
      await stream.sleep(200);
    }
  }),
);

// Rota registrada depois do boot e depois da primeira requisição (matcher do Hono já montado),
// como um plugin carregado tarde: tem de responder e aparecer na spec.
setTimeout(async () => {
  await app.request('/plugins');
  route({ method: 'get', path: '/echo/stats', summary: 'Plugin tardio', response: z.object({ count: z.number().int() }) }, (c) => c.json({ count: 42 }));
}, 100);

if (process.argv[2] === 'serve') serve({ fetch: fetchApp, port: 18787 }, () => console.log("a-manual em :18787"));
