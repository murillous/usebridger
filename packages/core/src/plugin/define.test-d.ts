// Testes de tipo do `definePlugin` (verificados pelo `pnpm typecheck`, ver message/types.test-d.ts).
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { definePlugin } from './define.ts';
import type { PluginDefinition } from './types.ts';

describe('definePlugin', () => {
  it('infere ctx.config de z.output do schema (defaults aplicados)', () => {
    definePlugin({
      name: 'sticker',
      version: '1.0.0',
      engine: '^1.0.0',
      config: z.object({ quality: z.number().default(80), label: z.string().optional() }),
      setup(ctx) {
        expectTypeOf(ctx.config).toEqualTypeOf<{ quality: number; label?: string | undefined }>();
      },
      teardown(ctx) {
        expectTypeOf(ctx.config.quality).toEqualTypeOf<number>();
      },
    });
  });

  it('infere as chaves de ctx.plugin.messages', () => {
    definePlugin({
      name: 'sticker',
      version: '1.0.0',
      engine: '^1.0.0',
      messages: { needMedia: 'Mande uma imagem' },
      setup(ctx) {
        expectTypeOf(ctx.plugin.messages.needMedia).toEqualTypeOf<string>();
        // @ts-expect-error chave que o plugin não declarou
        ctx.plugin.messages.outra;
      },
    });
  });

  it('ctx.t de comando só aceita as chaves de messages do plugin', () => {
    definePlugin({
      name: 'media',
      version: '1.0.0',
      engine: '^1.0.0',
      messages: { conversionError: 'Falhou', needMedia: 'Mande uma imagem' },
      commands: {
        sticker: {
          run(ctx) {
            ctx.t('conversionError');
            ctx.t('needMedia', { quem: 'você' });
            // @ts-expect-error chave que o plugin não declarou (erro de digitação)
            ctx.t('conversionEror');
          },
          onReject(ctx) {
            // @ts-expect-error chave que o plugin não declarou, também na recusa
            return ctx.t('needMediaa');
          },
        },
      },
      setup: () => undefined,
    });
  });

  it('sem schema, a config é unknown', () => {
    definePlugin({
      name: 'ping',
      version: '1.0.0',
      engine: '^1.0.0',
      setup(ctx) {
        expectTypeOf(ctx.config).toEqualTypeOf<unknown>();
      },
    });
  });

  it('requires só aceita capabilities conhecidas', () => {
    definePlugin({
      name: 'ping',
      version: '1.0.0',
      engine: '^1.0.0',
      // @ts-expect-error capability inexistente
      requires: ['send.hologram'],
      setup: () => undefined,
    });
  });

  it('plugin tipado cabe numa lista de PluginDefinition (fontes do loader)', () => {
    const typed = definePlugin({
      name: 'sticker',
      version: '1.0.0',
      engine: '^1.0.0',
      config: z.object({ quality: z.number() }),
      messages: { needMedia: 'x' },
      setup: () => undefined,
    });
    expectTypeOf(typed).toExtend<PluginDefinition>();
  });
});
