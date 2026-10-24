// `requires` por comando (ADR 0086): sem a capability, o comando não é registrado e some do
// roteador, do `ctx.commands.list()` e do menu nativo; o resto do plugin segue de pé.

import { afterEach, describe, expect, it } from 'vitest';
import { command } from '#commands/command.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext, PluginDefinition } from '#plugin/types.ts';
import type { Capability } from '#transport/capabilities.ts';
import type { TransportCommands, TransportDeps } from '#transport/types.ts';
import { type Bot, createBot } from './bot.ts';
import {
  type LogLine,
  message,
  RecordingTransport,
  recordingLogger,
  sentTexts,
} from './harness.test-support.ts';

const bots: Bot[] = [];

afterEach(async () => {
  for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
});

function start(plugins: PluginDefinition[], capabilities: Capability[]) {
  const transport = new RecordingTransport(capabilities);
  const lines: LogLine[] = [];
  let deps: TransportDeps | undefined;
  const bot = createBot({
    transport: (received) => {
      deps = received;
      return transport;
    },
    logger: recordingLogger(lines),
    env: {},
    plugins,
    outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
  });
  bots.push(bot);
  return { bot, transport, lines, menu: deps?.commands as TransportCommands };
}

const media = (onSetup: (ctx: PluginContext) => void = () => undefined): PluginDefinition =>
  definePlugin({
    name: 'media',
    version: '1.0.0',
    engine: '>=0.0.0',
    setup(ctx) {
      ctx.commands.add(
        command({ name: 'fig', requires: ['send.sticker'], run: () => 'figurinha' }),
      );
      ctx.commands.add(command({ name: 'img', requires: ['send.image'], run: () => 'imagem' }));
      onSetup(ctx);
    },
  });

describe('requires por comando (ADR 0086)', () => {
  it('sem a capability, o comando fica fora do roteador, do list() e do menu', async () => {
    let listed: string[] = [];
    const { bot, transport, lines, menu } = start(
      [
        media((ctx) => {
          listed = ctx.commands.list().map((c) => c.name);
        }),
      ],
      ['send.text', 'send.image'],
    );
    await bot.start();

    expect(listed).toEqual(['img']);
    expect(menu.list().map((c) => c.name)).toEqual(['img']);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({
          plugin: 'media',
          command: 'fig',
          missing: ['send.sticker'],
        }),
      }),
    );

    transport.emit('message', message('!fig'));
    transport.emit('message', message('!img'));
    await expect.poll(() => sentTexts(transport)).toEqual(['imagem']);
    await bot.settled();
    expect(sentTexts(transport)).toEqual(['imagem']);
  });

  it('a tabela de boot lista o comando deixado de fora junto do plugin', async () => {
    const { bot, lines } = start([media()], ['send.text', 'send.image']);
    await bot.start();

    expect(bot.plugins()).toEqual([
      expect.objectContaining({
        name: 'media',
        status: 'loaded',
        unregistered: [{ command: 'fig', missing: ['send.sticker'] }],
      }),
    ]);
    const table = lines.find((line) => line.fields['event'] === 'plugin.boot.review');
    expect(table?.level).toBe('warn');
    expect(table?.fields['report']).toContain('carregado; sem fig (send.sticker)');
  });

  it('com todas as capabilities, registra como qualquer comando', async () => {
    const { bot, menu } = start([media()], ['send.text', 'send.image', 'send.sticker']);
    await bot.start();
    expect(menu.list().map((c) => c.name)).toEqual(['fig', 'img']);
  });

  it('vale para o comando declarado no manifesto', async () => {
    const declared = definePlugin({
      name: 'declarado',
      version: '1.0.0',
      engine: '>=0.0.0',
      commands: {
        fig: { requires: ['send.sticker'], run: () => 'figurinha' },
        ping: { run: () => 'pong' },
      },
    });
    const { bot, menu } = start([declared], ['send.text']);
    await bot.start();
    expect(menu.list().map((c) => c.name)).toEqual(['ping']);
  });

  it('definição inválida lança mesmo sem a capability', async () => {
    let error: unknown;
    const plugin = definePlugin({
      name: 'quebrado',
      version: '1.0.0',
      engine: '>=0.0.0',
      setup(ctx) {
        try {
          ctx.commands.add({ name: 'f g', requires: ['send.sticker'], run: () => undefined });
        } catch (caught) {
          error = caught;
        }
      },
    });
    const { bot } = start([plugin], ['send.text']);
    await bot.start();
    expect(error).toBeInstanceOf(TypeError);
  });
});
