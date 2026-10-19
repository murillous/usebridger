// Pontos de extensão no `Bot` (#83, ADR 0092): o caso sticker/sticker-text do LumaBot. A etapa
// que o `sticker-text` contribui sai no teardown, reload e disable dele, sem `ctx.signal` no
// serviço do `sticker`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { command } from '#commands/command.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext } from '#plugin/types.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { type Bot, type BotConfig, createBot } from './bot.ts';
import { message, RecordingTransport, recordingLogger, sentTexts } from './harness.test-support.ts';

type Etapa = (texto: string) => string;

declare module '@usebridger/core' {
  interface ExtensionPoints {
    'figurinha.etapas': Etapa;
  }
}

const ENGINE = '>=0.0.0';
const bots: Bot[] = [];

afterEach(async () => {
  for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
});

function bot(config: Omit<BotConfig, 'env' | 'outbound'>): Bot {
  const created = createBot({
    env: {},
    // O setup quebrado de propósito loga erro: fica no logger de teste, fora da saída.
    logger: recordingLogger(),
    outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
    ...config,
  });
  bots.push(created);
  return created;
}

/** Oferece o ponto: `!fig <texto>` passa o texto por todas as etapas contribuídas. */
const figurinha = definePlugin({
  name: 'figurinha',
  version: '1.0.0',
  engine: ENGINE,
  setup(ctx) {
    const etapas = ctx.services.extensionPoint('figurinha.etapas');
    ctx.commands.add(
      command({
        name: 'fig',
        run: (c) => c.reply(etapas.list().reduce((texto, etapa) => etapa(texto), c.args.join(' '))),
      }),
    );
  },
});

/** Contribuidor que acrescenta `+<marca>`; `dependsOn` opcional para testar com e sem cascata. */
function contribuidor(name: string, marca: string, depende = true, after?: string[]) {
  return definePlugin({
    name,
    version: '1.0.0',
    engine: ENGINE,
    ...(depende && { dependsOn: { figurinha: '^1.0.0' } }),
    ...(after && { after }),
    setup(ctx) {
      ctx.services.contribute('figurinha.etapas', (texto) => `${texto}+${marca}`);
    },
  });
}

async function fig(b: Bot, transport: RecordingTransport, expected: string[]): Promise<void> {
  transport.emit('message', message('!fig x'));
  await b.settled();
  await vi.waitFor(() => expect(sentTexts(transport)).toEqual(expected));
}

describe('pontos de extensão no Bot (#83)', () => {
  it('a etapa contribuída roda no serviço de quem oferece o ponto', async () => {
    const transport = new RecordingTransport();
    const b = bot({
      transport,
      storage: createMemoryStorage(),
      plugins: [figurinha, contribuidor('legenda', 'legenda')],
    });
    await b.start();

    await fig(b, transport, ['x+legenda']);
  });

  it('reload do contribuidor não duplica a etapa', async () => {
    const transport = new RecordingTransport();
    const b = bot({
      transport,
      storage: createMemoryStorage(),
      plugins: [figurinha, contribuidor('legenda', 'legenda')],
    });
    await b.start();

    await b.plugins.reload('legenda');
    await b.plugins.reload('legenda');
    await fig(b, transport, ['x+legenda']);
  });

  it('disable do contribuidor tira a etapa; enable a devolve', async () => {
    const transport = new RecordingTransport();
    const b = bot({
      transport,
      storage: createMemoryStorage(),
      plugins: [figurinha, contribuidor('legenda', 'legenda')],
    });
    await b.start();

    await b.plugins.disable('legenda');
    await fig(b, transport, ['x']);

    await b.plugins.enable('legenda');
    await fig(b, transport, ['x', 'x+legenda']);
  });

  it('reload de quem oferece o ponto mantém as contribuições, sem duplicar', async () => {
    const transport = new RecordingTransport();
    const b = bot({
      transport,
      storage: createMemoryStorage(),
      // Um com `dependsOn` (recarrega em cascata) e outro sem (fica de pé).
      plugins: [
        figurinha,
        contribuidor('legenda', 'legenda'),
        contribuidor('borda', 'borda', false),
      ],
    });
    await b.start();

    await b.plugins.reload('figurinha');
    await fig(b, transport, ['x+legenda+borda']);
  });

  it('a ordem é a de carga e não muda com o reload de um contribuidor', async () => {
    const transport = new RecordingTransport();
    const b = bot({
      transport,
      storage: createMemoryStorage(),
      plugins: [
        figurinha,
        // Listado antes, mas o `after` o carrega depois: a ordem das etapas é a de carga.
        contribuidor('segundo', '2', true, ['primeiro']),
        contribuidor('primeiro', '1'),
      ],
    });
    await b.start();

    await b.plugins.reload('primeiro');
    await fig(b, transport, ['x+1+2']);
  });

  it('contribute depois do teardown lança, e setup que falha não deixa contribuição', async () => {
    let antigo: PluginContext | undefined;
    let quebra = false;
    const fragil = definePlugin({
      name: 'fragil',
      version: '1.0.0',
      engine: ENGINE,
      dependsOn: { figurinha: '^1.0.0' },
      setup(ctx) {
        antigo ??= ctx;
        ctx.services.contribute('figurinha.etapas', (texto) => `${texto}+fragil`);
        if (quebra) throw new Error('não subiu');
      },
    });
    const transport = new RecordingTransport();
    const b = bot({ transport, storage: createMemoryStorage(), plugins: [figurinha, fragil] });
    await b.start();

    quebra = true;
    await b.plugins.reload('fragil');
    expect(() => antigo?.services.contribute('figurinha.etapas', (t) => t)).toThrow(
      /services\.contribute depois que o contexto foi descartado/,
    );
    await fig(b, transport, ['x']);
  });
});
