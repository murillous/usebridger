import createClient from 'openapi-fetch';
import type { components, paths } from './api-live.d.ts';

const api = createClient<paths>({ baseUrl: 'http://localhost:18787' });

const { data, error } = await api.GET('/plugins', { params: { query: { enabled: 'true' } } });
if (error) throw new Error(error.title);
const names: string[] = data.items.map((p) => p.name);
console.log('lista', names, data.total);

const one = await api.GET('/plugins/{name}', { params: { path: { name: 'nao-existe' } } });
console.log('404', one.response.status, one.error?.title);

const patched = await api.PATCH('/plugins/{name}', { params: { path: { name: 'dashboard' } }, body: { enabled: true } });
console.log('patch', patched.data?.enabled);

// SSE: o tipo do item vem do componente, não da resposta (openapi-typescript ignora itemSchema).
type LogEvent = components['schemas']['LogEvent'];
const res = await fetch('http://localhost:18787/logs/stream');
const text = await res.text();
const events = text.split('\n\n').filter(Boolean).map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as LogEvent);
console.log('sse', events.map((e) => `${e.level}:${e.msg}`));

// @ts-expect-error rota inexistente na spec
await api.GET('/nao-existe');
// @ts-expect-error query fora do enum
await api.GET('/plugins', { params: { query: { enabled: 'talvez' } } });
