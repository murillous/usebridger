// M7-7 (ADR 0135): histórico de logs pela API, com filtros, cursor e permissão.

import { afterEach, describe, expect, it } from 'vitest';
import { createAuthStore } from '#auth/store.ts';
import { type Bot, createBot } from '#bot/bot.ts';
import { RecordingTransport, recordingLogger } from '#bot/harness.test-support.ts';
import { createHttp } from '#http/server.ts';
import type { LogSignal } from '#observers/observers.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext } from '#plugin/types.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { kernelStorage } from '#storage/namespace.ts';
import { LOG_HISTORY, LogHistory } from './logs.ts';

const line = (fields: Record<string, unknown>, level: LogSignal['level'] = 'info', time = 0) =>
  ({ level, time, message: 'm', fields }) satisfies LogSignal;

const all = { limit: LOG_HISTORY, visible: () => true };

describe('LogHistory', () => {
  it('pagina da mais nova para a mais antiga e só dá cursor se há mais', () => {
    const history = new LogHistory();
    for (let i = 1; i <= 5; i++) history.push(line({ i }));
    const first = history.page({}, { ...all, limit: 2 });
    expect(first.logs.map((l) => l.fields['i'])).toEqual([5, 4]);
    const second = history.page({}, { ...all, limit: 2, before: first.next });
    expect(second.logs.map((l) => l.fields['i'])).toEqual([3, 2]);
    const last = history.page({}, { ...all, limit: 2, before: second.next });
    expect(last.logs.map((l) => l.fields['i'])).toEqual([1]);
    expect(last.next).toBeUndefined();
    // Página exata no fim: sem cursor para uma página vazia.
    expect(history.page({}, { ...all, limit: 5 }).next).toBeUndefined();
  });

  it('filtra por nível mínimo, plugin, event e período', () => {
    const history = new LogHistory();
    history.push(line({ plugin: 'a', event: 'x.ok' }, 'debug', 100));
    history.push(line({ plugin: 'a', event: 'x.fail' }, 'error', 200));
    history.push(line({ plugin: 'b', event: 'x.fail' }, 'warn', 300));
    history.push(line({ event: 'kernel.y' }, 'info', 400));
    const pick = (filters: Parameters<LogHistory['page']>[0]) =>
      history.page(filters, all).logs.map((l) => l.time);
    expect(pick({ level: 'warn' })).toEqual([300, 200]);
    expect(pick({ plugin: 'a' })).toEqual([200, 100]);
    expect(pick({ event: 'x.fail' })).toEqual([300, 200]);
    expect(pick({ from: 200, to: 300 })).toEqual([300, 200]);
    expect(pick({ plugin: 'a', level: 'info' })).toEqual([200]);
  });

  it('guarda só as últimas LOG_HISTORY linhas', () => {
    const history = new LogHistory();
    for (let i = 1; i <= LOG_HISTORY * 2 + 5; i++) history.push(line({ i }));
    const page = history.page({}, all);
    expect(page.logs).toHaveLength(LOG_HISTORY);
    expect(page.logs.at(-1)?.fields['i']).toBe(LOG_HISTORY + 6);
    expect(page.next).toBeUndefined();
  });

  it('o que o ator não vê não conta para a página', () => {
    const history = new LogHistory();
    for (let i = 1; i <= 4; i++) history.push(line({ i }));
    const page = history.page({}, { limit: 2, visible: (l) => l.fields['i'] !== 4 });
    expect(page.logs.map((l) => l.fields['i'])).toEqual([3, 2]);
  });
});

const bots: Bot[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop().catch(() => undefined);
});

async function start() {
  const storage = createMemoryStorage();
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const transport = new RecordingTransport();
  let ctx: PluginContext | undefined;
  const bot = createBot({
    transport,
    logger: recordingLogger(),
    env: {},
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
          context.http.route('GET', '/ping', () => new Response('pong'));
        },
      }),
    ],
  });
  bots.push(bot);
  await bot.start();
  const key = async (permissions: readonly string[]) => {
    const { secret } = await createAuthStore(kernelStorage(storage, 'auth')).createApiKey(
      { name: 'k', permissions: [...permissions] },
      new Date(),
    );
    return { authorization: `Bearer ${secret}` };
  };
  return {
    base: `http://127.0.0.1:${http.port}/api`,
    key,
    transport,
    plugin: () => ctx as PluginContext,
  };
}

describe('GET /logs', () => {
  it('devolve as linhas no formato do evento log do SSE, filtradas e com cursor', async () => {
    const { base, key, plugin } = await start();
    const log = plugin().log;
    log.info('um', { event: 'p.teste', n: 1 });
    log.warn('dois', { event: 'p.teste', n: 2 });
    log.error('três', { event: 'p.outro', n: 3 });
    const headers = await key(['logs.read']);
    const get = async (query: string) => {
      const res = await fetch(`${base}/logs?${query}`, { headers });
      expect(res.status).toBe(200);
      return (await res.json()) as { logs: LogSignal[]; next?: number };
    };

    const first = await get('plugin=p&event=p.teste&limit=1');
    expect(first.logs).toEqual([
      {
        level: 'warn',
        time: expect.any(Number),
        message: 'dois',
        fields: expect.objectContaining({ plugin: 'p', event: 'p.teste', n: 2 }),
      },
    ]);
    expect(first.next).toEqual(expect.any(Number));
    const second = await get(`plugin=p&event=p.teste&limit=1&before=${first.next}`);
    expect(second.logs.map((l) => l.fields['n'])).toEqual([1]);
    expect(second.next).toBeUndefined();

    expect((await get('plugin=p&level=warn')).logs.map((l) => l.fields['n'])).toEqual([3, 2]);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await get(`plugin=p&from=${future}`)).logs).toEqual([]);
  });

  it('sem logs.read é 403; sem credencial, 401; filtro inválido, 400', async () => {
    const { base, key } = await start();
    expect((await fetch(`${base}/logs`, { headers: await key(['audit.read']) })).status).toBe(403);
    expect((await fetch(`${base}/logs`)).status).toBe(401);
    const headers = await key(['logs.read']);
    expect((await fetch(`${base}/logs?level=loud`, { headers })).status).toBe(400);
    expect((await fetch(`${base}/logs?limit=0`, { headers })).status).toBe(400);
  });

  it('o valor do QR no log só sai com connection.manage, como no SSE', async () => {
    const { base, key, transport } = await start();
    transport.emit('connection.qr', { qr: 'QR-1' });
    const events = async (permissions: string[]) => {
      const res = await fetch(`${base}/logs`, { headers: await key(permissions) });
      const body = (await res.json()) as { logs: LogSignal[] };
      return body.logs.map((l) => l.fields['event']);
    };
    const reader = await events(['logs.read']);
    expect(reader).toContain('connection.qr.received');
    expect(reader).not.toContain('connection.qr.value');
    expect(await events(['logs.read', 'connection.manage'])).toContain('connection.qr.value');
  });
});

describe('404 em rota de plugin', () => {
  it('explica que a rota é do plugin, que pode não estar carregado', async () => {
    const { base, key } = await start();
    const res = await fetch(`${base}/plugins/metrics/query`, {
      headers: await key(['metrics.read']),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(((await res.json()) as { detail: string }).detail).toContain('plugin "metrics"');
  });
});
