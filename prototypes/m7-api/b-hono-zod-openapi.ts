// Opção B: @hono/zod-openapi. A spec mora no OpenAPIHono; o core remonta o app a cada mudança,
// então cada remontagem refaz o registro de todas as rotas.
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';

const Plugin = z.object({ name: z.string(), version: z.string(), enabled: z.boolean() }).meta({ id: 'Plugin' });
const LogEvent = z.object({ ts: z.string(), event: z.string(), msg: z.string() }).meta({ id: 'LogEvent' });

const table: Array<Parameters<OpenAPIHono['openapi']>> = [];
const build = () => {
  const app = new OpenAPIHono();
  for (const [route, handler] of table) app.openapi(route, handler);
  return app;
};

table.push([
  createRoute({
    method: 'get',
    path: '/plugins',
    request: { query: z.object({ q: z.string().optional() }) },
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.object({ items: z.array(Plugin) }) } } } },
  }),
  (c) => c.json({ items: [] }, 200),
]);
table.push([
  createRoute({
    method: 'get',
    path: '/logs/stream',
    // `itemSchema` não existe no tipo de MediaType (openapi3-ts 3.1); o cast é o único caminho.
    responses: { 200: { description: 'OK', content: { 'text/event-stream': { itemSchema: LogEvent } as never } } },
  }),
  (c) => c.text('') as never,
]);
let app = build();
const late = createRoute({ method: 'get', path: '/echo/stats', responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.object({ count: z.number() }) } } } } });
table.push([late, (c) => c.json({ count: 42 }, 200)]);
app = build();

const doc = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'Bridger', version: '0' } });
console.log(doc.openapi, Object.keys(doc.paths ?? {}), Object.keys(doc.components?.schemas ?? {}));
console.log(JSON.stringify(doc.paths?.['/plugins']?.get?.responses?.['200']));
console.log(JSON.stringify(doc.paths?.['/logs/stream']?.get?.responses?.['200']));
console.log('late', (await app.request('/echo/stats')).status);
