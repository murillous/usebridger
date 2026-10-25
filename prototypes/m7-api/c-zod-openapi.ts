// Opção C: zod-openapi. Documento é um objeto simples gerado de uma tabela, sem acoplar ao Hono.
import { z } from 'zod';
import { createDocument } from 'zod-openapi';

const Plugin = z.object({ name: z.string(), version: z.string(), enabled: z.boolean() }).meta({ id: 'Plugin' });
const LogEvent = z.object({ ts: z.string(), event: z.string(), msg: z.string() }).meta({ id: 'LogEvent' });

const paths: Record<string, unknown> = {
  '/plugins': {
    get: {
      requestParams: { query: z.object({ q: z.string().optional() }) },
      responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.object({ items: z.array(Plugin) }) } } } },
    },
  },
  '/logs/stream': {
    get: { responses: { 200: { description: 'OK', content: { 'text/event-stream': { itemSchema: LogEvent } } } } },
  },
};
// Rota tardia: basta acrescentar à tabela e regerar.
paths['/echo/stats'] = { get: { responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.object({ count: z.number() }) } } } } } };

for (const openapi of ['3.1.0', '3.2.0'] as const) {
  try {
    const doc = createDocument({ openapi, info: { title: 'Bridger', version: '0' }, paths } as never);
    console.log(doc.openapi, Object.keys(doc.paths ?? {}), Object.keys(doc.components?.schemas ?? {}));
    console.log(JSON.stringify((doc.paths as never)['/plugins'].get.responses['200']));
    console.log(JSON.stringify((doc.paths as never)['/logs/stream'].get.responses['200']));
  } catch (e) {
    console.log(openapi, 'ERRO', (e as Error).message);
  }
}
