// ADR 0111: `ctx.admin` só para os plugins em `adminPlugins`.

import { afterEach, describe, expect, it } from 'vitest';
import { ContextExpiredError } from '#deadline.ts';
import { definePlugin } from '#plugin/define.ts';
import { PluginHostStateError } from '#plugin/host.ts';
import type { PluginContext } from '#plugin/types.ts';
import { type Bot, type BotConfig, createBot } from './bot.ts';
import { RecordingTransport, recordingLogger } from './harness.test-support.ts';

const bots: Bot[] = [];
afterEach(async () => {
  for (const b of bots.splice(0)) await b.stop().catch(() => undefined);
});

function setup(config: Partial<BotConfig> = {}) {
  const ctxs: Record<string, PluginContext> = {};
  const plugin = (name: string) =>
    definePlugin({
      name,
      version: '1.0.0',
      engine: '>=0.0.0',
      setup(ctx) {
        ctxs[name] = ctx;
      },
    });
  const log = recordingLogger();
  const bot = createBot({
    logger: log,
    env: {},
    transport: new RecordingTransport(),
    plugins: [plugin('dash'), plugin('other')],
    ...config,
  });
  bots.push(bot);
  const admin = (): NonNullable<PluginContext['admin']> => {
    const found = ctxs['dash']?.admin;
    if (!found) throw new Error('sem admin');
    return found;
  };
  return { bot, ctxs, log, admin };
}

describe('ctx.admin', () => {
  it('só quem está em adminPlugins recebe; os demais veem undefined', async () => {
    const { bot, ctxs } = setup({ adminPlugins: ['dash'] });
    await bot.start();
    expect(ctxs['dash']?.admin).toBeDefined();
    expect(ctxs['other']?.admin).toBeUndefined();
  });

  it('lista a tabela e desliga, liga e recarrega outro plugin', async () => {
    const { bot, admin } = setup({ adminPlugins: ['dash'] });
    await bot.start();
    expect(
      admin()
        .plugins()
        .map((e) => e.name),
    ).toEqual(['dash', 'other']);
    await admin().plugins.disable('other');
    expect(bot.plugins().find((e) => e.name === 'other')?.status).toBe('skipped');
    await admin().plugins.enable('other');
    expect(bot.plugins().find((e) => e.name === 'other')?.status).toBe('loaded');
    await expect(admin().plugins.reload('other')).resolves.toBeDefined();
  });

  it('expõe describe/jsonSchema/setOverrides de outro plugin', async () => {
    const { bot, admin } = setup({ adminPlugins: ['dash'] });
    await bot.start();
    // Mesmas instâncias de `bot.config`: o resultado é o mesmo.
    expect(admin().config.describe('other')).toEqual(bot.config.describe('other'));
    expect(admin().config.jsonSchema('other')).toEqual(bot.config.jsonSchema('other'));
    await expect(admin().config.setOverrides('other', {})).resolves.toEqual(
      await bot.config.setOverrides('other', {}),
    );
  });

  it('rejeita disable, reload e setOverrides sobre o próprio plugin', async () => {
    const { bot, admin } = setup({ adminPlugins: ['dash'] });
    await bot.start();
    await expect(admin().plugins.disable('dash')).rejects.toBeInstanceOf(PluginHostStateError);
    await expect(admin().plugins.reload('dash')).rejects.toBeInstanceOf(PluginHostStateError);
    await expect(admin().config.setOverrides('dash', {})).rejects.toBeInstanceOf(
      PluginHostStateError,
    );
    expect(bot.plugins().find((e) => e.name === 'dash')?.status).toBe('loaded');
  });

  it('avisa de nome em adminPlugins que não existe', async () => {
    const { bot, log } = setup({ adminPlugins: ['dash', 'fantasma'] });
    await bot.start();
    const warns = log.lines.filter((l) => l.level === 'warn').map((l) => l.message);
    expect(warns).toContain('adminPlugins cita "fantasma", que não existe entre os plugins');
  });

  it('sem adminPlugins, todos veem undefined', async () => {
    const { bot, ctxs } = setup();
    await bot.start();
    expect(ctxs['dash']?.admin).toBeUndefined();
    expect(ctxs['other']?.admin).toBeUndefined();
  });

  it('depois do reload o contexto novo segue com admin e recusa o próprio plugin', async () => {
    const { bot, admin } = setup({ adminPlugins: ['dash'] });
    await bot.start();
    await bot.plugins.reload('dash');
    await expect(admin().plugins.disable('dash')).rejects.toBeInstanceOf(PluginHostStateError);
  });

  it('depois do dispose as ações rejeitam com ContextExpiredError e as leituras seguem', async () => {
    const { bot, admin } = setup({ adminPlugins: ['dash'] });
    await bot.start();
    const old = admin();
    await bot.plugins.disable('dash');
    await expect(old.plugins.disable('other')).rejects.toBeInstanceOf(ContextExpiredError);
    await expect(old.plugins.reload('other')).rejects.toBeInstanceOf(ContextExpiredError);
    await expect(old.config.setOverrides('other', {})).rejects.toBeInstanceOf(ContextExpiredError);
    expect(bot.plugins().find((e) => e.name === 'other')?.status).toBe('loaded');
    expect(old.plugins().length).toBe(2);
  });
});
