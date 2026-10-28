// ADR 0133: auditoria pela API (consulta com cursor, exportação auditada e verify).

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
// O dreno da auditoria roda a cada 1 s (AUDIT_FLUSH_MS).
const WAIT_MS = 5000;

const bots: Bot[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop().catch(() => undefined);
});

async function start() {
  const storage = createMemoryStorage();
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  let ctx: PluginContext | undefined;
  const bot = createBot({
    transport: new RecordingTransport(),
    logger: recordingLogger(),
    env: { BRIDGER_SECRET_KEY: KEY },
    storage,
    http,
    api: { auth: {} },
    adminPlugins: ['p'],
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
  const plugin = ctx as PluginContext;
  const base = `http://127.0.0.1:${http.port}/api`;
  const key = async (permissions: readonly string[]) => {
    const { secret } = await createAuthStore(kernelStorage(storage, 'auth')).createApiKey(
      { name: 'k', permissions: [...permissions] },
      new Date(),
    );
    return { authorization: `Bearer ${secret}` };
  };
  /** Grava pelo plugin e espera o dreno (fila FIFO): achar o último é achar todos. */
  const seed = async (records: Parameters<PluginContext['audit']['record']>[0][]) => {
    for (const input of records) plugin.audit.record(input);
    const last = records.at(-1);
    await vi.waitFor(
      async () => {
        const page = await plugin.audit.query({
          action: last?.action,
          ...(last?.target && { target: last.target.id }),
        });
        expect(page.events.length).toBeGreaterThan(0);
      },
      { timeout: WAIT_MS },
    );
  };
  const rows = (): Promise<AuditEvent[]> =>
    plugin.audit.query({ limit: 1000 }).then((page) => [...page.events]);
  return { base, key, seed, rows, storage };
}

describe('GET /audit', () => {
  it('filtra por ação, alvo e resultado e pagina pelo cursor', async () => {
    const { base, key, seed } = await start();
    await seed([
      { action: 'p.ticket.open', target: { type: 'ticket', id: 't1' } },
      { action: 'p.ticket.open', target: { type: 'ticket', id: 't2' } },
      { action: 'p.ticket.open', target: { type: 'ticket', id: 't3' }, outcome: 'error' },
      { action: 'p.ticket.close', target: { type: 'ticket', id: 't1' } },
    ]);
    const headers = await key(['audit.read']);
    const get = async (query: string) => {
      const res = await fetch(`${base}/audit?${query}`, { headers });
      expect(res.status).toBe(200);
      return (await res.json()) as { events: AuditEvent[]; next?: number };
    };

    const first = await get('action=p.ticket.open&outcome=success&limit=1');
    expect(first.events.map((e) => e.targetId)).toEqual(['t1']);
    const second = await get(`action=p.ticket.open&outcome=success&limit=1&after=${first.next}`);
    expect(second.events.map((e) => e.targetId)).toEqual(['t2']);
    const end = await get(`action=p.ticket.open&outcome=success&after=${second.next}`);
    expect(end).toEqual({ events: [] });

    expect((await get('target=t1&actor=p')).events.map((e) => e.action)).toEqual([
      'p.ticket.open',
      'p.ticket.close',
    ]);
    expect((await get('outcome=error')).events.map((e) => e.targetId)).toEqual(['t3']);
  });

  it('filtra por período', async () => {
    const { base, key, seed, rows } = await start();
    await seed([{ action: 'p.x.y' }]);
    const headers = await key(['audit.read']);
    const at = (await rows()).find((e) => e.action === 'p.x.y')?.at as string;
    const before = new Date(Date.parse(at) - 1).toISOString();
    const after = new Date(Date.parse(at) + 1).toISOString();
    const count = async (query: string) =>
      (
        (await (await fetch(`${base}/audit?action=p.x.y&${query}`, { headers })).json()) as {
          events: unknown[];
        }
      ).events.length;
    expect(await count(`from=${before}&to=${after}`)).toBe(1);
    expect(await count(`from=${after}`)).toBe(0);
    expect(await count(`to=${before}`)).toBe(0);
    expect((await fetch(`${base}/audit?from=ontem`, { headers })).status).toBe(400);
    expect((await fetch(`${base}/audit?limit=1001`, { headers })).status).toBe(400);
  });

  it('mostra o onBehalfOf do ator nas linhas', async () => {
    const { base, key } = await start();
    const bff = await key(['audit.read', 'auth.on-behalf-of']);
    const delegated = { ...bff, 'x-bridger-on-behalf-of': 'maria@empresa' };
    expect(
      (await fetch(`${base}/audit/verify`, { method: 'POST', headers: delegated })).status,
    ).toBe(200);
    await fetch(`${base}/audit/export`, { headers: delegated }).then((res) => res.text());
    await vi.waitFor(
      async () => {
        const page = (await (
          await fetch(`${base}/audit?action=kernel.audit.export`, { headers: bff })
        ).json()) as { events: AuditEvent[] };
        expect(page.events[0]?.actor).toMatchObject({ kind: 'user', onBehalfOf: 'maria@empresa' });
      },
      { timeout: WAIT_MS },
    );
    const csv = await (
      await fetch(`${base}/audit/export?format=csv&action=kernel.audit.export`, { headers: bff })
    ).text();
    expect(csv.split('\r\n')[1]).toContain(',maria@empresa,');
  });

  it('exige audit.read: 403 sem ela; o viewer a tem', async () => {
    const { base, key } = await start();
    expect(rolePermissions('viewer')).toContain('audit.read');
    const headers = await key(['plugins.read']);
    expect((await fetch(`${base}/audit`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/audit/export`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/audit/verify`, { method: 'POST', headers })).status).toBe(403);
  });
});

describe('GET /audit/export', () => {
  it('JSON: array com os eventos filtrados, e a exportação entra na auditoria', async () => {
    const { base, key, seed, rows } = await start();
    await seed([
      { action: 'p.ticket.open', target: { type: 'ticket', id: 't1' } },
      { action: 'p.ticket.close', target: { type: 'ticket', id: 't1' } },
    ]);
    const headers = await key(['audit.read']);
    const res = await fetch(`${base}/audit/export?action=p.ticket.open`, { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="audit.json"');
    const events = (await res.json()) as AuditEvent[];
    expect(events.map((e) => [e.action, e.targetId])).toEqual([['p.ticket.open', 't1']]);
    await vi.waitFor(
      async () => {
        expect((await rows()).find((e) => e.action === 'kernel.audit.export')).toMatchObject({
          actor: { kind: 'user' },
          outcome: 'success',
          details: { format: 'json', filters: { action: 'p.ticket.open' } },
        });
      },
      { timeout: WAIT_MS },
    );
  });

  it('JSON sem eventos é um array vazio', async () => {
    const { base, key } = await start();
    const headers = await key(['audit.read']);
    const res = await fetch(`${base}/audit/export?action=nada.aqui`, { headers });
    expect(await res.json()).toEqual([]);
  });

  it('CSV: cabeçalho, uma linha por evento, aspas escapadas e fórmula neutralizada', async () => {
    const { base, key, seed } = await start();
    await seed([
      { action: 'p.note.add', target: { type: 'note', id: '=HYPERLINK("x")' } },
      { action: 'p.note.add', target: { type: 'note', id: 'n2' }, details: { a: 'b,c' } },
    ]);
    const headers = await key(['audit.read']);
    const res = await fetch(`${base}/audit/export?format=csv&action=p.note.add`, { headers });
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    const lines = (await res.text()).split('\r\n');
    expect(lines[0]).toBe(
      'seq,eventId,at,actorKind,actorId,actorName,onBehalfOf,via,action,targetType,targetId,' +
        'outcome,ip,userAgent,tenant,session,trace,details,prevHash,hash',
    );
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('');
    expect(lines[1]).toContain(`,note,"'=HYPERLINK(""x"")",success,`);
    expect(lines[2]).toContain(',plugin,p,p,,,p.note.add,note,n2,success,');
    expect(lines[2]).toContain(',"{""a"":""b,c""}",');
  });

  it('percorre mais de uma página do query', async () => {
    const { base, key, seed } = await start();
    await seed(
      Array.from({ length: 1001 }, (_, i) => ({
        action: 'p.bulk.item',
        target: { type: 'item', id: String(i) },
      })),
    );
    const headers = await key(['audit.read']);
    const events = (await (
      await fetch(`${base}/audit/export?action=p.bulk.item`, { headers })
    ).json()) as AuditEvent[];
    expect(events).toHaveLength(1001);
    expect(events.at(-1)?.targetId).toBe('1000');
  });
});

describe('POST /audit/verify', () => {
  it('cadeia íntegra é ok; adulterada aponta o elo', async () => {
    const { base, key, seed, storage } = await start();
    await seed([{ action: 'p.a.b' }, { action: 'p.a.c' }]);
    const headers = await key(['audit.read']);
    const verify = async () =>
      (await (await fetch(`${base}/audit/verify`, { method: 'POST', headers })).json()) as {
        ok: boolean;
        checked: number;
        brokenAt?: { seq: number; reason: string };
      };
    const intact = await verify();
    expect(intact.ok).toBe(true);
    expect(intact.checked).toBeGreaterThanOrEqual(2);

    const col = storage.forNamespace('$audit').collection('audit');
    const [row] = await col.find({ where: { action: 'p.a.c' } });
    await col.update({ action: 'p.a.c' }, { outcome: 'denied' });
    const broken = await verify();
    expect(broken).toMatchObject({
      ok: false,
      brokenAt: { seq: row?.['seq'], reason: 'hash não confere: evento alterado' },
    });
  });
});
