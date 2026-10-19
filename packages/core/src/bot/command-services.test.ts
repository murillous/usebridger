// Comando que exige serviço (#84, ADR 0095): sem o serviço provido, o comando fica fora do
// roteador, do `ctx.commands.list()` e do menu; com `optionalDependsOn`, ele some e volta junto
// com o provedor, e o plugin que o declara carrega mesmo sem o provedor.

import { afterEach, describe, expect, it } from 'vitest';
import { command } from '#commands/command.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginDefinition } from '#plugin/types.ts';
import type { TransportCommands, TransportDeps } from '#transport/types.ts';
import { type Bot, createBot } from './bot.ts';
import {
  type LogLine,
  message,
  RecordingTransport,
  recordingLogger,
  sentTexts,
} from './harness.test-support.ts';

interface Figurinhas {
  cria(): string;
}

declare module '@usebridger/core' {
  interface Services {
    figurinhas: Figurinhas;
  }
}

const ENGINE = '>=0.0.0';
const bots: Bot[] = [];

afterEach(async () => {
  for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
});

function start(plugins: PluginDefinition[], disabledPlugins: string[] = []) {
  const transport = new RecordingTransport(['send.text']);
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
    ...(disabledPlugins.length > 0 && { disabledPlugins }),
    outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
  });
  bots.push(bot);
  return { bot, transport, lines, menu: deps?.commands as TransportCommands };
}

/** Provedor do serviço; a versão entra na resposta para o teste ver qual instância respondeu. */
const sticker = (version = 1): PluginDefinition =>
  definePlugin({
    name: 'sticker',
    version: '1.0.0',
    engine: ENGINE,
    setup(ctx) {
      ctx.services.provide('figurinhas', { cria: () => `figurinha v${version}` });
    },
  });

/** O `download` do LumaBot: carrega sem o `sticker`, e só o `ds` depende dele. */
const download = definePlugin({
  name: 'download',
  version: '1.0.0',
  engine: ENGINE,
  optionalDependsOn: { sticker: '^1.0.0' },
  commands: {
    ds: {
      services: ['figurinhas'],
      run: (_, plugin) => plugin.services.get('figurinhas').cria(),
    },
    baixa: { run: () => 'baixado' },
  },
});

const names = (menu: TransportCommands) => menu.list().map((c) => c.name);

describe('services por comando (ADR 0095)', () => {
  it('sem o provedor, o plugin carrega e só o comando fica de fora', async () => {
    const { bot, transport, menu, lines } = start([download]);
    await bot.start();

    expect(names(menu)).toEqual(['baixa']);
    expect(bot.plugins()).toEqual([
      expect.objectContaining({
        name: 'download',
        status: 'loaded',
        unregistered: [{ command: 'ds', missing: [], services: ['figurinhas'] }],
      }),
    ]);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({
          plugin: 'download',
          command: 'ds',
          services: ['figurinhas'],
        }),
      }),
    );
    const table = lines.find((line) => line.message.startsWith('Plugins:'));
    expect(table?.message).toContain('carregado; sem ds (serviço figurinhas)');

    transport.emit('message', message('!ds'));
    transport.emit('message', message('!baixa'));
    await expect.poll(() => sentTexts(transport)).toEqual(['baixado']);
    await bot.settled();
    expect(sentTexts(transport)).toEqual(['baixado']);
  });

  it('com o provedor, registra o comando mesmo declarado antes dele', async () => {
    // `download` vem antes na lista: o `optionalDependsOn` põe o `sticker` antes na carga.
    const { bot, transport, menu } = start([download, sticker()]);
    await bot.start();

    expect(names(menu)).toEqual(['ds', 'baixa']);
    transport.emit('message', message('!ds'));
    await expect.poll(() => sentTexts(transport)).toEqual(['figurinha v1']);
  });

  it('o provedor que falha no setup do reload não derruba o plugin', async () => {
    // No boot, o provedor que falha derruba o boot (ADR 0098); em runtime, o dependente opcional
    // segue sem ele.
    let broken = false;
    const flaky = definePlugin({
      name: 'sticker',
      version: '1.0.0',
      engine: ENGINE,
      setup(ctx) {
        if (broken) throw new Error('sem ffmpeg');
        ctx.services.provide('figurinhas', { cria: () => 'figurinha' });
      },
    });
    const { bot, menu } = start([download, flaky]);
    await bot.start();
    broken = true;
    await bot.plugins.reload('sticker');

    expect(bot.plugins()).toContainEqual(
      expect.objectContaining({ name: 'download', status: 'loaded' }),
    );
    expect(names(menu)).toEqual(['baixa']);
  });

  it('desligar e ligar o provedor tira e devolve o comando', async () => {
    const { bot, transport, menu } = start([download, sticker()]);
    await bot.start();

    const off = await bot.plugins.disable('sticker');
    expect(off.dependents).toEqual([
      expect.objectContaining({
        name: 'download',
        status: 'loaded',
        unregistered: [{ command: 'ds', missing: [], services: ['figurinhas'] }],
      }),
    ]);
    expect(names(menu)).toEqual(['baixa']);

    const on = await bot.plugins.enable('sticker');
    expect(on.dependents).toEqual([
      expect.not.objectContaining({ unregistered: expect.anything() }),
    ]);
    expect(names(menu)).toEqual(['ds', 'baixa']);
    transport.emit('message', message('!ds'));
    await expect.poll(() => sentTexts(transport)).toEqual(['figurinha v1']);
  });

  it('o provedor desligado no boot sobe com o comando depois do enable', async () => {
    const { bot, menu } = start([download, sticker()], ['sticker']);
    await bot.start();
    expect(names(menu)).toEqual(['baixa']);

    await bot.plugins.enable('sticker');
    expect(names(menu)).toEqual(['ds', 'baixa']);
  });

  it('recarregar o provedor recarrega o plugin em cascata', async () => {
    let setups = 0;
    const counted = definePlugin({
      name: 'download',
      version: '1.0.0',
      engine: ENGINE,
      optionalDependsOn: { sticker: '^1.0.0' },
      setup(ctx) {
        setups++;
        ctx.commands.add(
          command({
            name: 'ds',
            services: ['figurinhas'],
            run: () => ctx.services.get('figurinhas').cria(),
          }),
        );
      },
    });
    const { bot } = start([counted, sticker()]);
    await bot.start();

    const result = await bot.plugins.reload('sticker');
    expect(result.dependents.map((entry) => entry.name)).toEqual(['download']);
    expect(setups).toBe(2);
  });

  it('sem optionalDependsOn, o reload do provedor não mexe no plugin', async () => {
    let setups = 0;
    const loose = definePlugin({
      name: 'solto',
      version: '1.0.0',
      engine: ENGINE,
      after: ['sticker'],
      setup(ctx) {
        setups++;
        ctx.commands.add(command({ name: 'ds', services: ['figurinhas'], run: () => 'x' }));
      },
    });
    const { bot } = start([loose, sticker()]);
    await bot.start();

    const result = await bot.plugins.reload('sticker');
    expect(result.dependents).toEqual([]);
    expect(setups).toBe(1);
  });

  it('serviço provido pelo próprio plugin antes do add conta como provido', async () => {
    const own = definePlugin({
      name: 'proprio',
      version: '1.0.0',
      engine: ENGINE,
      setup(ctx) {
        ctx.services.provide('figurinhas', { cria: () => 'própria' });
        ctx.commands.add(command({ name: 'ds', services: ['figurinhas'], run: () => 'ok' }));
      },
    });
    const { bot, menu } = start([own]);
    await bot.start();
    expect(names(menu)).toEqual(['ds']);
  });

  it('provedor fora da faixa não impede a carga e avisa em warn', async () => {
    const old = definePlugin({
      name: 'download',
      version: '1.0.0',
      engine: ENGINE,
      optionalDependsOn: { sticker: '^2.0.0' },
      commands: {
        ds: {
          services: ['figurinhas'],
          run: (_, plugin) => plugin.services.get('figurinhas').cria(),
        },
      },
    });
    const { bot, menu, lines } = start([old, sticker()]);
    await bot.start();

    expect(bot.plugins()).toContainEqual(
      expect.objectContaining({ name: 'download', status: 'loaded' }),
    );
    // O serviço já está no registry: o comando registra, e o aviso fica para o operador.
    expect(names(menu)).toEqual(['ds']);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({
          plugin: 'download',
          dependency: 'sticker',
          range: '^2.0.0',
          version: '1.0.0',
        }),
      }),
    );
  });

  it('^0.0.z no optionalDependsOn avisa como no dependsOn', async () => {
    const exact = definePlugin({
      name: 'download',
      version: '1.0.0',
      engine: ENGINE,
      optionalDependsOn: { sticker: '^0.0.3' },
      setup: () => undefined,
    });
    const { bot, lines } = start([exact]);
    await bot.start();
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('optionalDependsOn["sticker"] = "^0.0.3"'),
      }),
    );
  });

  it('nome de serviço inválido lança na definição', () => {
    expect(() =>
      command({ name: 'ds', services: [''] as unknown as ['figurinhas'], run: () => undefined }),
    ).toThrow(/services do comando "ds"/);
  });
});
