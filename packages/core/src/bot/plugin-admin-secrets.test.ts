// ADR 0117 no bot: ctx.admin.config.setSecret/clearSecret, rotação e chave inválida no boot.

import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BotConfigError } from '#config/owners.ts';
import { secret } from '#config/schema.ts';
import { encrypt, keyId, type SecretEnvelope } from '#config/secret-cipher.ts';
import { ContextExpiredError } from '#deadline.ts';
import { definePlugin } from '#plugin/define.ts';
import { PluginHostStateError } from '#plugin/host.ts';
import { PluginBootError } from '#plugin/report.ts';
import type { PluginContext } from '#plugin/types.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { kernelStorage } from '#storage/namespace.ts';
import { type Bot, type BotConfig, createBot } from './bot.ts';
import { RecordingTransport, recordingLogger } from './harness.test-support.ts';

const bots: Bot[] = [];
afterEach(async () => {
  for (const b of bots.splice(0)) await b.stop().catch(() => undefined);
});

const keyA = randomBytes(32).toString('base64');
const keyB = randomBytes(32).toString('base64');
const VALUE = 'sk-0123456789';

/** Storage com um segredo de `other` já cifrado com `key` (o storage fecha junto com o bot). */
async function seeded(key: string): Promise<ReturnType<typeof createMemoryStorage>> {
  const storage = createMemoryStorage();
  const envelope = encrypt(Buffer.from(key, 'base64'), 'other:apiKey', JSON.stringify(VALUE));
  await kernelStorage(storage, 'secrets').kv.set('other', { apiKey: envelope });
  return storage;
}

function setup(config: Partial<BotConfig> = {}) {
  const ctxs: Record<string, PluginContext> = {};
  const plugin = (name: string, extra: object = {}) =>
    definePlugin({
      name,
      version: '1.0.0',
      engine: '>=0.0.0',
      setup(ctx) {
        ctxs[name] = ctx;
      },
      ...extra,
    });
  const bot = createBot({
    logger: recordingLogger(),
    env: { BRIDGER_SECRET_KEY: keyA },
    transport: new RecordingTransport(),
    adminPlugins: ['dash'],
    ...config,
    plugins: [
      plugin('dash', { config: z.object({ token: secret(z.string().min(8)).optional() }) }),
      plugin('other', { config: z.object({ apiKey: secret(z.string().min(8)).optional() }) }),
    ],
  });
  bots.push(bot);
  const admin = (): NonNullable<PluginContext['admin']> => {
    const found = ctxs['dash']?.admin;
    if (!found) throw new Error('sem admin');
    return found;
  };
  return { bot, ctxs, admin };
}

describe('ctx.admin.config: segredos', () => {
  it('setSecret e clearSecret de outro plugin recarregam e ele lê o valor', async () => {
    const { bot, ctxs, admin } = setup();
    await bot.start();
    expect(admin().config.secretsWritable).toBe(true);
    await admin().config.setSecret('other', 'apiKey', VALUE);
    expect(ctxs['other']?.config).toMatchObject({ apiKey: VALUE });
    expect(bot.config.secretsWritable).toBe(true);
    await admin().config.clearSecret('other', 'apiKey');
    expect(ctxs['other']?.config).not.toHaveProperty('apiKey');
  });

  it('segredo salvo que não decifra aborta o boot do plugin, como config inválida', async () => {
    const storage = await seeded(keyA);
    const { bot } = setup({ storage, env: { BRIDGER_SECRET_KEY: keyB } });
    const error = await bot.start().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PluginBootError);
    expect(String(error)).toContain('não decifra');
    expect(String(error)).not.toContain(VALUE);
  });

  it('clearSecret e setSecret sobre plugin desligado gravam e pulam o reload; enable sobe', async () => {
    const storage = await seeded(keyA);
    const { bot, admin } = setup({
      storage,
      env: { BRIDGER_SECRET_KEY: keyB },
      disabledPlugins: ['other'],
    });
    await bot.start();
    expect(bot.plugins().find((e) => e.name === 'other')?.status).toBe('skipped');
    // Plugin desligado: grava e pula o reload, sem erro.
    await expect(admin().config.clearSecret('other', 'apiKey')).resolves.toBeUndefined();
    await admin().plugins.enable('other');
    expect(bot.plugins().find((e) => e.name === 'other')?.status).toBe('loaded');
  });

  it('rejeita setSecret e clearSecret sobre o próprio plugin', async () => {
    const { bot, admin } = setup();
    await bot.start();
    await expect(admin().config.setSecret('dash', 'token', VALUE)).rejects.toBeInstanceOf(
      PluginHostStateError,
    );
    await expect(admin().config.clearSecret('dash', 'token')).rejects.toBeInstanceOf(
      PluginHostStateError,
    );
  });

  it('depois do dispose as escritas rejeitam com ContextExpiredError', async () => {
    const { bot, admin } = setup();
    await bot.start();
    const old = admin();
    await bot.plugins.disable('dash');
    await expect(old.config.setSecret('other', 'apiKey', VALUE)).rejects.toBeInstanceOf(
      ContextExpiredError,
    );
    await expect(old.config.clearSecret('other', 'apiKey')).rejects.toBeInstanceOf(
      ContextExpiredError,
    );
  });

  it('sem chave mestra secretsWritable é false e setSecret rejeita', async () => {
    const { bot, admin } = setup({ env: {} });
    await bot.start();
    expect(admin().config.secretsWritable).toBe(false);
    await expect(admin().config.setSecret('other', 'apiKey', VALUE)).rejects.toThrow(
      'BRIDGER_SECRET_KEY',
    );
  });

  it('chave mestra inválida falha o boot', async () => {
    const { bot } = setup({ env: { BRIDGER_SECRET_KEY: 'curta' } });
    await expect(bot.start()).rejects.toBeInstanceOf(BotConfigError);
  });

  it('no boot com a chave anterior, migra os envelopes antigos para a atual', async () => {
    const storage = await seeded(keyA);
    const { bot, ctxs } = setup({
      storage,
      env: { BRIDGER_SECRET_KEY: keyB, BRIDGER_SECRET_KEY_PREVIOUS: keyA },
    });
    await bot.start();
    expect(ctxs['other']?.config).toMatchObject({ apiKey: VALUE });
    const stored = await kernelStorage(storage, 'secrets').kv.get<Record<string, SecretEnvelope>>(
      'other',
    );
    expect(keyId(Buffer.from(keyB, 'base64'))).toBe(stored?.['apiKey']?.kid);
  });
});
