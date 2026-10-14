import { definePlugin } from '@usebridger/core';
import { z } from '@usebridger/core/zod';
import { expect, it } from 'vitest';
import { z as dependency } from 'zod';

it('reexporta o Zod da dependência do core, não outra cópia', () => {
  expect(z).toBe(dependency);
});

it('schema do subpath serve de config no definePlugin', () => {
  const plugin = definePlugin({
    name: 'saudacao',
    version: '0.1.0',
    engine: '*',
    config: z.object({ texto: z.string().default('oi') }),
    setup: () => undefined,
  });
  expect(plugin.config?.parse({})).toEqual({ texto: 'oi' });
});
