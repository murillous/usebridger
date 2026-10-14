// Tipos de `commands` e `on` no manifesto (ADR 0079), verificados pelo `pnpm typecheck`.
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import type {
  CommandContext,
  CommandRejection,
  MediaCommandContext,
  RejectContext,
} from '#commands/command.ts';
import type { Media, TextMessage } from '#message/types.ts';
import { definePlugin } from './define.ts';
import type { PluginDefinition } from './types.ts';

describe('definePlugin com commands e on', () => {
  it('o 2º argumento traz a config e as mensagens tipadas', () => {
    definePlugin({
      name: 'saldo',
      version: '1.0.0',
      engine: '*',
      config: z.object({ moeda: z.string().default('R$') }),
      messages: { vazio: 'Sem saldo' },
      commands: {
        saldo: {
          run(c, plugin) {
            expectTypeOf(c).toEqualTypeOf<CommandContext<'vazio'>>();
            expectTypeOf(plugin.config).toEqualTypeOf<{ moeda: string }>();
            expectTypeOf(plugin.plugin.messages.vazio).toEqualTypeOf<string>();
            return plugin.config.moeda;
          },
        },
      },
      on: {
        'message:text': (e, plugin) => {
          expectTypeOf(e.message).toEqualTypeOf<TextMessage>();
          expectTypeOf(plugin.config.moeda).toEqualTypeOf<string>();
        },
        'connection.qr': (e) => {
          expectTypeOf(e.payload.qr).toEqualTypeOf<string>();
        },
      },
    });
  });

  it('o onReject recebe o contexto do plugin no 3º argumento', () => {
    definePlugin({
      name: 'midia',
      version: '1.0.0',
      engine: '*',
      messages: { uso: 'Mande uma figurinha' },
      commands: {
        imagem: {
          accepts: ['sticker'],
          onReject(c, rejection, plugin) {
            expectTypeOf(c).toEqualTypeOf<RejectContext<'uso'>>();
            expectTypeOf(rejection).toEqualTypeOf<CommandRejection>();
            expectTypeOf(plugin.plugin.messages.uso).toEqualTypeOf<string>();
            return plugin.plugin.messages.uso;
          },
          run: () => undefined,
        },
      },
    });
  });

  it('estreita o contexto do run pelo accepts de cada comando', () => {
    const plugin: PluginDefinition = definePlugin({
      name: 'midia',
      version: '1.0.0',
      engine: '*',
      config: z.object({ moeda: z.string() }),
      commands: {
        imagem: {
          accepts: ['sticker', 'quoted:sticker'],
          run(c, plugin) {
            expectTypeOf(c).toEqualTypeOf<MediaCommandContext>();
            expectTypeOf(plugin.config.moeda).toEqualTypeOf<string>();
          },
        },
        sticker: {
          accepts: ['image', 'args'],
          run: (c) => expectTypeOf(c.media).toEqualTypeOf<Media | null>(),
        },
        ping: { run: (c) => expectTypeOf(c).toEqualTypeOf<CommandContext>() },
      },
    });
    expectTypeOf(plugin).toEqualTypeOf<PluginDefinition>();
  });

  it('cabe na anotação larga que o isolatedDeclarations exige', () => {
    const plugin: PluginDefinition = definePlugin({
      name: 'saldo',
      version: '1.0.0',
      engine: '*',
      config: z.object({ moeda: z.string() }),
      commands: { saldo: { run: (_c, { config }) => config.moeda } },
      on: { message: (_e, { config }) => config.moeda },
    });
    expectTypeOf(plugin).toEqualTypeOf<PluginDefinition>();
  });

  it('barra evento desconhecido e comando sem run', () => {
    definePlugin({
      name: 'p',
      version: '1.0.0',
      engine: '*',
      // @ts-expect-error: erro de digitação no nome do evento
      on: { mesage: () => undefined },
    });
    definePlugin({
      name: 'p',
      version: '1.0.0',
      engine: '*',
      // @ts-expect-error: comando sem run
      commands: { ping: { description: 'x' } },
    });
  });
});
