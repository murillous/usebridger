// ADR 0122: ações do kernel auditadas automaticamente (plugin, config, segredo, boot, stop).

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AuditEvent } from '#audit/types.ts';
import { secret } from '#config/schema.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext } from '#plugin/types.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { type Bot, createBot } from './bot.ts';
import { RecordingTransport, recordingLogger } from './harness.test-support.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const VALUE = 'valor-secreto-12345';

const bots: Bot[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop().catch(() => undefined);
});

function setup(options: { failSetup?: boolean } = {}) {
  const inner = createMemoryStorage();
  // O stop fecha o storage; o teste lê depois dele.
  const storage = { ...inner, close: async () => undefined };
  const ctxs: Record<string, PluginContext> = {};
  let breakNext = false;
  const bot = createBot({
    transport: new RecordingTransport(),
    logger: recordingLogger(),
    env: { BRIDGER_SECRET_KEY: KEY },
    storage,
    adminPlugins: ['dash'],
    plugins: [
      definePlugin({
        name: 'dash',
        version: '1.0.0',
        engine: '>=0.0.0',
        setup(ctx) {
          ctxs['dash'] = ctx;
        },
      }),
      definePlugin({
        name: 'other',
        version: '1.0.0',
        engine: '>=0.0.0',
        config: z.object({
          label: z.string().default('a'),
          apiKey: secret(z.string().min(8)).optional(),
        }),
        setup(ctx) {
          ctxs['other'] = ctx;
          if (options.failSetup && breakNext) throw new Error('setup quebrou');
        },
      }),
    ],
  });
  bots.push(bot);
  const rows = async (): Promise<AuditEvent[]> =>
    (await storage
      .forNamespace('$audit')
      .collection('audit')
      .find({ orderBy: 'seq' })) as unknown as AuditEvent[];
  const admin = () => ctxs['dash']?.admin as NonNullable<PluginContext['admin']>;
  return { bot, rows, admin, breakSetup: () => (breakNext = true) };
}

describe('auditoria das ações do kernel', () => {
  it('plugin enable/disable/reload: ator system pelo bot.plugins e plugin pelo ctx.admin', async () => {
    const { bot, rows, admin } = setup();
    await bot.start();
    await bot.plugins.disable('other');
    await bot.plugins.enable('other');
    await admin().plugins.reload('other');
    await bot.stop();
    const events = (await rows()).filter((e) => e.action.startsWith('kernel.plugin.'));
    expect(events.map((e) => [e.action, e.actor, e.outcome])).toEqual([
      ['kernel.plugin.disable', { kind: 'system' }, 'success'],
      ['kernel.plugin.enable', { kind: 'system' }, 'success'],
      ['kernel.plugin.reload', { kind: 'plugin', name: 'dash' }, 'success'],
    ]);
    expect(events[0]?.target).toEqual({ type: 'plugin', id: 'other' });
    expect(events[0]?.details).toEqual({ plugin: 'other' });
  });

  it('reload com setup que falha, e plugin desconhecido, geram outcome error', async () => {
    const { bot, rows, breakSetup } = setup({ failSetup: true });
    await bot.start();
    breakSetup();
    await bot.plugins.reload('other');
    await expect(bot.plugins.reload('nao-existe')).rejects.toThrow();
    await bot.stop();
    const events = (await rows()).filter((e) => e.action === 'kernel.plugin.reload');
    expect(events.map((e) => [e.target?.id, e.outcome])).toEqual([
      ['other', 'error'],
      ['nao-existe', 'error'],
    ]);
  });

  it('recusa sobre si mesmo (ADR 0107) grava denied com o plugin como ator', async () => {
    const { bot, rows, admin } = setup();
    await bot.start();
    await expect(admin().plugins.disable('dash')).rejects.toThrow();
    await bot.stop();
    const denied = (await rows()).find((e) => e.action === 'kernel.plugin.disable');
    expect(denied).toMatchObject({ outcome: 'denied', actor: { kind: 'plugin', name: 'dash' } });
  });

  it('setOverrides grava o diff por caminho; segredo nunca aparece com valor', async () => {
    const { bot, rows, admin } = setup();
    await bot.start();
    await bot.config.setSecret('other', 'apiKey', VALUE);
    await admin().config.setOverrides('other', { label: 'b' });
    await bot.config.clearSecret('other', 'apiKey');
    await bot.stop();
    const all = await rows();
    const update = all.find((e) => e.action === 'kernel.config.update');
    expect(update).toMatchObject({
      actor: { kind: 'plugin', name: 'dash' },
      target: { type: 'plugin', id: 'other' },
      outcome: 'success',
      details: { changes: { label: { from: 'a', to: 'b' } } },
    });
    const secrets = all.filter((e) => e.action === 'kernel.secret.update');
    expect(secrets.map((e) => e.details)).toEqual([
      { plugin: 'other', path: 'apiKey', op: 'set' },
      { plugin: 'other', path: 'apiKey', op: 'clear' },
    ]);
    expect(JSON.stringify(all)).not.toContain(VALUE);
  });

  it('setSecret que falha grava error, só com o caminho', async () => {
    const { bot, rows } = setup();
    await bot.start();
    await expect(bot.config.setSecret('other', 'label', VALUE)).rejects.toThrow();
    await bot.stop();
    const all = await rows();
    expect(all.find((e) => e.action === 'kernel.secret.update')).toMatchObject({
      outcome: 'error',
      details: { path: 'label' },
    });
    expect(JSON.stringify(all)).not.toContain(VALUE);
  });

  it('kernel.boot e kernel.stop entram na cadeia na cadeia de hash', async () => {
    const { bot, rows } = setup();
    await bot.start();
    await bot.plugins.disable('other');
    await bot.stop();
    const all = await rows();
    expect(all[0]).toMatchObject({ action: 'kernel.boot', actor: { kind: 'system' } });
    expect((all[0]?.details as { plugins: string[] } | undefined)?.plugins).toEqual([
      'dash',
      'other',
    ]);
    expect(all.at(-1)?.action).toBe('kernel.stop');
    // Cadeia íntegra: cada elo aponta para o hash do anterior.
    for (const [index, event] of all.entries()) {
      expect(event.seq).toBe(index + 1);
      if (index > 0) expect(event.prevHash).toBe(all[index - 1]?.hash);
    }
  });
});
