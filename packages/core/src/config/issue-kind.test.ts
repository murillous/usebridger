// `PluginConfigIssue.kind` distingue override de secret de problema de validação sem ler texto.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createSecretSet } from '#logger/secrets.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { PluginConfigError } from './errors.ts';
import { createPluginConfigs } from './plugin-configs.ts';
import { secret } from './schema.ts';

const ai = {
  name: 'ai',
  version: '1.0.0',
  engine: '^1.0.0',
  setup: () => undefined,
  config: z.object({
    quality: z.number().min(1).default(5),
    apiKey: secret(z.string().min(8)),
  }),
};

function configs() {
  return createPluginConfigs({
    plugins: [ai],
    storage: createMemoryStorage(),
    secrets: createSecretSet(),
    env: {},
    file: { ai: { apiKey: 'sk-0123456789' } },
  });
}

describe('PluginConfigIssue.kind', () => {
  it("override de campo secreto sai com kind 'secret'", async () => {
    const error = await configs()
      .setOverrides('ai', { apiKey: 'x' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PluginConfigError);
    expect((error as PluginConfigError).issues).toEqual([
      expect.objectContaining({ path: 'apiKey', kind: 'secret' }),
    ]);
  });

  it("valor inválido sai com kind 'invalid'", async () => {
    const error = await configs()
      .setOverrides('ai', { quality: 0 })
      .catch((e: unknown) => e);
    expect((error as PluginConfigError).issues).toEqual([
      expect.objectContaining({ path: 'quality', kind: 'invalid' }),
    ]);
  });
});
