// ADR 0122: `ctx.audit` ligado ao bot (ator do plugin, admin, descarte e parada).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '#audit/types.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext } from '#plugin/types.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import type { StoragePort } from '#storage/types.ts';
import { type Bot, createBot } from './bot.ts';
import { RecordingTransport, recordingLogger } from './harness.test-support.ts';
import { SESSION_LEASE_RENEW_MS } from './session-lease.ts';

const bots: Bot[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop().catch(() => undefined);
});

// O stop fecha o storage; o teste lê depois dele, então o `close` não fecha nada.
function openMemory(): ReturnType<typeof createMemoryStorage> {
  const inner = createMemoryStorage();
  return { ...inner, close: async () => undefined };
}

function build(name: string, adminPlugins: string[], storage = openMemory()) {
  const ctxs: Record<string, PluginContext> = {};
  const plugin = definePlugin({
    name,
    version: '1.0.0',
    engine: '>=0.0.0',
    setup(ctx) {
      ctxs[name] = ctx;
    },
  });
  const bot = createBot({
    transport: new RecordingTransport(),
    logger: recordingLogger(),
    env: {},
    storage,
    plugins: [plugin],
    adminPlugins,
  });
  bots.push(bot);
  return { bot, ctx: () => ctxs[name] as PluginContext, storage };
}

const audited = async (storage: ReturnType<typeof createMemoryStorage>): Promise<AuditEvent[]> =>
  (await storage
    .forNamespace('$audit')
    .collection('audit')
    .find({ orderBy: 'seq' })) as unknown as AuditEvent[];

describe('ctx.audit', () => {
  it('grava no stop, com o ator do plugin, e o admin consulta e verifica', async () => {
    const { bot, ctx, storage } = build('dash', ['dash']);
    await bot.start();
    ctx().audit.record({ action: 'dash.config.update', details: { token: 'abc' } });
    expect(() => ctx().audit.record({ action: 'outro.x' })).toThrow(TypeError);
    const page = await ctx().audit.query();
    expect(page.events).toEqual([]); // ainda na fila: gravação assíncrona
    await bot.stop();
    const rows = await audited(storage);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: { kind: 'plugin', name: 'dash' },
      details: { token: '[REDACTED]' },
      session: 'default',
    });
  });

  it('plugin fora de adminPlugins não consulta nem verifica', async () => {
    const { bot, ctx } = build('inbox', []);
    await bot.start();
    await expect(ctx().audit.query()).rejects.toThrow(/adminPlugins/);
    await expect(ctx().audit.verify()).rejects.toThrow(/adminPlugins/);
  });

  it('recusa o record depois do dispose do plugin', async () => {
    const { bot, ctx } = build('inbox', []);
    await bot.start();
    const audit = ctx().audit;
    await bot.stop();
    expect(() => audit.record({ action: 'inbox.late' })).toThrow();
  });
});

describe('trava de sessão perdida', () => {
  it('descarta a fila com lease-lost, sem gravar', async () => {
    vi.useFakeTimers();
    try {
      let held = true;
      const inner = openMemory();
      // O insert da auditoria falha: os eventos ficam na fila até a trava ser perdida.
      const storage = {
        ...inner,
        forNamespace(namespace: string) {
          const ns = inner.forNamespace(namespace);
          if (namespace !== '$audit') return ns;
          return {
            ...ns,
            collection: (name: string, options?: { indexes?: readonly string[] }) => ({
              ...ns.collection(name, options),
              insert: () => Promise.reject(new Error('fora do ar')),
            }),
          };
        },
        acquireLease: async () => held,
        releaseLease: async () => undefined,
      } as unknown as StoragePort;
      const dropped: unknown[] = [];
      const plugin = definePlugin({
        name: 'p',
        version: '1.0.0',
        engine: '>=0.0.0',
        setup(ctx) {
          ctx.observe('audit.dropped', (signal) => dropped.push(signal));
          ctx.audit.record({ action: 'p.a' });
          ctx.audit.record({ action: 'p.b' });
        },
      });
      const bot = createBot({
        transport: new RecordingTransport(),
        logger: recordingLogger(),
        env: {},
        storage,
        plugins: [plugin],
      });
      bots.push(bot);
      await bot.start();
      held = false;
      await vi.advanceTimersByTimeAsync(SESSION_LEASE_RENEW_MS + 100);
      expect(dropped).toContainEqual({ count: 2, reason: 'lease-lost' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('boot e shutdown da auditoria', () => {
  it('avisa audit.unkeyed no boot sem BRIDGER_SECRET_KEY, e não com ela', async () => {
    const lines = recordingLogger();
    const bot = createBot({
      transport: new RecordingTransport(),
      logger: lines,
      env: {},
      plugins: [],
    });
    bots.push(bot);
    await bot.start();
    expect(lines.lines.some((l) => l.fields['event'] === 'audit.unkeyed')).toBe(true);

    const keyed = recordingLogger();
    const other = createBot({
      transport: new RecordingTransport(),
      logger: keyed,
      env: { BRIDGER_SECRET_KEY: Buffer.alloc(32, 3).toString('base64') },
      plugins: [],
    });
    bots.push(other);
    await other.start();
    expect(keyed.lines.some((l) => l.fields['event'] === 'audit.unkeyed')).toBe(false);
  });

  it('o prazo do audit.stop é limitado pelo shutdown.timeoutMs total', async () => {
    const inner = openMemory();
    const storage = {
      ...inner,
      forNamespace(namespace: string) {
        const ns = inner.forNamespace(namespace);
        if (namespace !== '$audit') return ns;
        return {
          ...ns,
          collection: (name: string, options?: { indexes?: readonly string[] }) => ({
            ...ns.collection(name, options),
            insert: () => new Promise<string>(() => undefined),
          }),
        };
      },
    } as unknown as StoragePort;
    const log = recordingLogger();
    const plugin = definePlugin({
      name: 'p',
      version: '1.0.0',
      engine: '>=0.0.0',
      setup(ctx) {
        ctx.audit.record({ action: 'p.a' });
      },
    });
    const bot = createBot({
      transport: new RecordingTransport(),
      logger: log,
      env: {},
      storage,
      plugins: [plugin],
      shutdown: { hookTimeoutMs: 30_000, timeoutMs: 300 },
    });
    bots.push(bot);
    await bot.start();
    const started = Date.now();
    await bot.stop();
    expect(Date.now() - started).toBeLessThan(3000);
    // O plugin (e o observador dele) já desceu: o descarte aparece no log.
    expect(
      log.lines.some(
        (l) => l.fields['event'] === 'audit.dropped' && l.fields['reason'] === 'shutdown',
      ),
    ).toBe(true);
  });
});
