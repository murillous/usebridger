// Segredos cifrados no storage (ADR 0121): camada `secret`, setSecret/clearSecret e rotação.

import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { recordingLogger } from '#bot/harness.test-support.ts';
import { createSecretSet } from '#logger/secrets.ts';
import type { PluginDefinition } from '#plugin/types.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { kernelStorage } from '#storage/namespace.ts';
import type { ConfigEnv } from './env.ts';
import { PluginConfigError } from './errors.ts';
import { createPluginConfigs, type PluginConfigFile } from './plugin-configs.ts';
import { SECRET_MASK, secret } from './schema.ts';

const ai: PluginDefinition = {
  name: 'ai',
  version: '1.0.0',
  engine: '^1.0.0',
  setup: () => undefined,
  config: z.object({
    model: z.string().default('flash'),
    apiKey: secret(z.string().min(8)).optional(),
    openai: z.object({ token: secret(z.string().min(8)).optional() }).default({}),
  }),
};

// Campo obrigatório: remover o segredo deixa a config inválida.
const strict: PluginDefinition = {
  name: 'strict',
  version: '1.0.0',
  engine: '^1.0.0',
  setup: () => undefined,
  config: z.object({ apiKey: secret(z.string().min(8)) }),
};

const keyA = randomBytes(32).toString('base64');
const keyB = randomBytes(32).toString('base64');
const VALUE = 'sk-0123456789';

function setup(
  options: {
    env?: ConfigEnv;
    file?: PluginConfigFile;
    storage?: ReturnType<typeof createMemoryStorage>;
  } = {},
) {
  const storage = options.storage ?? createMemoryStorage();
  const log = recordingLogger();
  const secrets = createSecretSet();
  const reload = vi.fn(async () => undefined as never);
  const configs = createPluginConfigs({
    plugins: [ai, strict],
    storage,
    env: { BRIDGER_SECRET_KEY: keyA, ...options.env },
    file: options.file,
    secrets,
    log,
    reload,
  });
  return { configs, storage, log, secrets, reload, kv: kernelStorage(storage, 'secrets').kv };
}

const issueOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PluginConfigError);
  return (error as PluginConfigError).issues[0];
};

describe('setSecret e a camada secret', () => {
  it('salva cifrado, resolve com fonte secret, mascara no describe e recarrega', async () => {
    const { configs, kv, reload, secrets } = setup();
    expect(configs.secretsWritable).toBe(true);
    await configs.setSecret('ai', 'apiKey', VALUE);
    await configs.setSecret('ai', 'openai.token', 'tok-9876543210');
    expect(reload).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenLastCalledWith('ai');
    expect(JSON.stringify(await kv.get('ai'))).not.toContain(VALUE);
    expect((await configs.resolve('ai')).config).toMatchObject({
      apiKey: VALUE,
      openai: { token: 'tok-9876543210' },
    });
    const view = await configs.describe('ai');
    expect(view.config).toMatchObject({ apiKey: SECRET_MASK, openai: { token: SECRET_MASK } });
    expect(view.sources['apiKey']).toBe('secret');
    expect(view.sources['openai.token']).toBe('secret');
    expect(view.sources['model']).toBe('default');
    expect(secrets.values()).toContain(VALUE);
  });

  it('precedência: o segredo vale mais que o override e o default', async () => {
    const { configs, storage } = setup();
    await kernelStorage(storage, 'config').kv.set('ai', { model: 'pro' });
    await configs.setSecret('ai', 'apiKey', VALUE);
    const view = await configs.describe('ai');
    expect(view.sources).toMatchObject({ model: 'override', apiKey: 'secret' });
  });

  it('env e arquivo sombreiam o segredo salvo; setSecret rejeita com shadowed', async () => {
    const env = setup({ env: { BRIDGER_AI__API_KEY: 'env-key-123456' } });
    expect(await issueOf(env.configs.setSecret('ai', 'apiKey', VALUE))).toMatchObject({
      kind: 'shadowed',
      source: 'env',
      env: 'BRIDGER_AI__API_KEY',
    });
    const file = setup({ file: { ai: { openai: { token: 'file-token-123' } } } });
    expect(await issueOf(file.configs.setSecret('ai', 'openai.token', VALUE))).toMatchObject({
      kind: 'shadowed',
      source: 'file',
    });
    expect(await file.kv.get('ai')).toBeUndefined();
    expect(file.reload).not.toHaveBeenCalled();

    // Um segredo já salvo fica atrás do env e do arquivo na resolução.
    const { configs, kv } = setup();
    await configs.setSecret('ai', 'apiKey', VALUE);
    const withEnv = setup({
      storage: undefined,
      env: { BRIDGER_AI__API_KEY: 'env-key-123456' },
    });
    await withEnv.kv.set('ai', (await kv.get('ai')) as never);
    expect((await withEnv.configs.resolve('ai')).config).toMatchObject({
      apiKey: 'env-key-123456',
    });
    expect((await withEnv.configs.describe('ai')).sources['apiKey']).toBe('env');
  });

  it('recusa caminho que não é secret, desconhecido, e sem chave mestra', async () => {
    const { configs } = setup();
    expect(await issueOf(configs.setSecret('ai', 'model', 'x'))).toMatchObject({
      kind: 'invalid',
      path: 'model',
    });
    expect(await issueOf(configs.setSecret('ai', 'nada', 'x'))).toMatchObject({ kind: 'invalid' });
    expect(await issueOf(configs.setSecret('ai', 'openai', 'x'))).toMatchObject({
      kind: 'invalid',
    });

    const noKey = setup({ env: { BRIDGER_SECRET_KEY: undefined } });
    expect(noKey.configs.secretsWritable).toBe(false);
    const issue = await issueOf(noKey.configs.setSecret('ai', 'apiKey', VALUE));
    expect(issue?.message).toContain('BRIDGER_SECRET_KEY');
    expect(await noKey.kv.get('ai')).toBeUndefined();
  });

  it('valor inválido é rejeitado e nada muda', async () => {
    const { configs, kv, reload } = setup();
    expect(await issueOf(configs.setSecret('ai', 'apiKey', 'curta'))).toMatchObject({
      path: 'apiKey',
      source: 'secret',
    });
    expect(await kv.get('ai')).toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
  });

  it('loga info em cada escrita e remoção, nunca o valor', async () => {
    const { configs, log } = setup();
    await configs.setSecret('ai', 'apiKey', VALUE);
    await configs.clearSecret('ai', 'apiKey');
    const infos = log.lines.filter((line) => line.level === 'info');
    expect(infos).toHaveLength(2);
    expect(infos[0]?.fields).toMatchObject({ plugin: 'ai', field: 'apiKey', source: 'secret' });
    expect(JSON.stringify(log.lines)).not.toContain(VALUE);
  });

  it('setOverrides segue recusando segredo', async () => {
    const { configs } = setup();
    expect(await issueOf(configs.setOverrides('ai', { apiKey: VALUE }))).toMatchObject({
      kind: 'secret',
    });
  });

  it('escritas concorrentes são serializadas', async () => {
    const { configs, reload } = setup();
    await Promise.all([
      configs.setSecret('ai', 'apiKey', VALUE),
      configs.setSecret('ai', 'openai.token', 'tok-9876543210'),
    ]);
    expect(reload).toHaveBeenCalledTimes(2);
    expect((await configs.resolve('ai')).config).toMatchObject({
      apiKey: VALUE,
      openai: { token: 'tok-9876543210' },
    });
  });
});

describe('clearSecret', () => {
  it('remove, volta à camada de baixo e recarrega', async () => {
    const { configs, kv, reload } = setup();
    await configs.setSecret('ai', 'apiKey', VALUE);
    await configs.clearSecret('ai', 'apiKey');
    expect(await kv.get('ai')).toBeUndefined();
    expect(reload).toHaveBeenCalledTimes(2);
    expect((await configs.resolve('ai')).config).not.toHaveProperty('apiKey');
  });

  it('campo obrigatório sem valor rejeita e nada muda', async () => {
    const { configs, kv } = setup();
    await configs.setSecret('strict', 'apiKey', VALUE);
    expect(await issueOf(configs.clearSecret('strict', 'apiKey'))).toMatchObject({
      path: 'apiKey',
    });
    expect(await kv.get('strict')).toBeDefined();
  });

  it('recusa caminho que não é secret e nunca salvo', async () => {
    const { configs } = setup();
    expect(await issueOf(configs.clearSecret('ai', 'model'))).toMatchObject({ kind: 'invalid' });
  });
});

describe('envelope ilegível', () => {
  it('vira undecryptable com plugin, caminho e fonte secret, sem valor', async () => {
    const { configs, kv } = setup();
    await configs.setSecret('ai', 'apiKey', VALUE);
    const other = setup({ env: { BRIDGER_SECRET_KEY: keyB }, storage: undefined });
    await other.kv.set('ai', (await kv.get('ai')) as never);
    const error = await other.configs.resolve('ai').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PluginConfigError);
    const { plugin, issues } = error as PluginConfigError;
    expect(plugin).toBe('ai');
    expect(issues).toEqual([
      expect.objectContaining({ kind: 'undecryptable', source: 'secret', path: 'apiKey' }),
    ]);
    expect(String(error)).not.toContain(VALUE);
  });

  it('sem chave mestra também é ilegível, e clearSecret limpa mesmo assim', async () => {
    const { configs, kv } = setup();
    await configs.setSecret('ai', 'apiKey', VALUE);
    const noKey = setup({ env: { BRIDGER_SECRET_KEY: undefined } });
    await noKey.kv.set('ai', (await kv.get('ai')) as never);
    await expect(noKey.configs.resolve('ai')).rejects.toMatchObject({
      issues: [expect.objectContaining({ kind: 'undecryptable' })],
    });
    await noKey.configs.clearSecret('ai', 'apiKey');
    await expect(noKey.configs.resolve('ai')).resolves.toBeDefined();
  });
});

describe('JSON Schema', () => {
  it('marca x-bridger-set-secret só com chave mestra, mantendo x-bridger-override: false', () => {
    const prop = (json: unknown) =>
      (json as { properties: { apiKey: Record<string, unknown> } }).properties.apiKey;
    const withKey = prop(setup().configs.jsonSchema('ai'));
    expect(withKey).toMatchObject({ 'x-bridger-override': false, 'x-bridger-set-secret': true });
    const without = prop(
      setup({ env: { BRIDGER_SECRET_KEY: undefined } }).configs.jsonSchema('ai'),
    );
    expect(without).toMatchObject({ 'x-bridger-override': false });
    expect(without).not.toHaveProperty('x-bridger-set-secret');
  });
});

describe('rotação da chave mestra', () => {
  async function seed() {
    const first = setup();
    await first.configs.setSecret('ai', 'apiKey', VALUE);
    await first.configs.setSecret('ai', 'openai.token', 'tok-9876543210');
    await first.configs.setSecret('strict', 'apiKey', 'strict-key-123');
    return first.storage;
  }

  it('migra tudo para a chave atual; o segundo boot não migra de novo', async () => {
    const storage = await seed();
    const rotated = setup({
      storage,
      env: { BRIDGER_SECRET_KEY: keyB, BRIDGER_SECRET_KEY_PREVIOUS: keyA },
    });
    expect(await rotated.configs.rotateSecrets()).toBe(3);
    expect(rotated.log.lines.some((l) => l.level === 'info' && l.message.includes('3'))).toBe(true);
    expect((await rotated.configs.resolve('ai')).config).toMatchObject({ apiKey: VALUE });
    expect((await rotated.configs.resolve('strict')).config).toMatchObject({
      apiKey: 'strict-key-123',
    });
    // Sem a anterior: só a atual decifra tudo.
    const onlyNew = setup({ storage, env: { BRIDGER_SECRET_KEY: keyB } });
    expect((await onlyNew.configs.resolve('ai')).config).toMatchObject({ apiKey: VALUE });
    const again = setup({
      storage,
      env: { BRIDGER_SECRET_KEY: keyB, BRIDGER_SECRET_KEY_PREVIOUS: keyA },
    });
    expect(await again.configs.rotateSecrets()).toBe(0);
  });

  it('PREVIOUS sem envelopes antigos não faz nada', async () => {
    const first = setup({ env: { BRIDGER_SECRET_KEY: keyB } });
    await first.configs.setSecret('ai', 'apiKey', VALUE);
    const before = JSON.stringify(await first.kv.get('ai'));
    const run = setup({
      storage: first.storage,
      env: { BRIDGER_SECRET_KEY: keyB, BRIDGER_SECRET_KEY_PREVIOUS: keyA },
    });
    expect(await run.configs.rotateSecrets()).toBe(0);
    expect(JSON.stringify(await first.kv.get('ai'))).toBe(before);
  });

  it('kid desconhecido fica como está e segue o caminho de ilegível', async () => {
    const storage = await seed();
    const keyC = randomBytes(32).toString('base64');
    const run = setup({
      storage,
      env: { BRIDGER_SECRET_KEY: keyB, BRIDGER_SECRET_KEY_PREVIOUS: keyC },
    });
    expect(await run.configs.rotateSecrets()).toBe(0);
    await expect(run.configs.resolve('ai')).rejects.toMatchObject({
      issues: [
        expect.objectContaining({ kind: 'undecryptable', path: 'apiKey' }),
        expect.objectContaining({ kind: 'undecryptable', path: 'openai.token' }),
      ],
    });
  });

  it('sem chave anterior a rotação não faz nada', async () => {
    expect(await setup().configs.rotateSecrets()).toBe(0);
  });
});
