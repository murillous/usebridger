// ADR 0122: `ctx.audit` ligado ao bot (ator do plugin, admin, descarte e parada).

import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '#audit/types.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext } from '#plugin/types.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { type Bot, createBot } from './bot.ts';
import { RecordingTransport, recordingLogger } from './harness.test-support.ts';

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
