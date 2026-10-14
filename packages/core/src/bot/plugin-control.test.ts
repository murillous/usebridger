// Desligar, ligar e recarregar plugin em execução pela API do `Bot` (#85), sem passar pela config:
// nada de override gravado, e o comando some e volta junto com o plugin.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { command } from '#commands/command.ts';
import { definePlugin } from '#plugin/define.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { type Bot, type BotConfig, createBot } from './bot.ts';
import { message, RecordingTransport, recordingLogger, sentTexts } from './harness.test-support.ts';

const ENGINE = '>=0.0.0';
const bots: Bot[] = [];

afterEach(async () => {
  for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
});

function bot(config: Omit<BotConfig, 'env' | 'outbound'>): Bot {
  const created = createBot({
    env: {},
    logger: recordingLogger(),
    outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
    ...config,
  });
  bots.push(created);
  return created;
}

const base = definePlugin({
  name: 'base',
  version: '1.0.0',
  engine: ENGINE,
  setup(ctx) {
    ctx.commands.add(command({ name: 'base', run: (c) => c.reply('base') }));
  },
});

const filho = definePlugin({
  name: 'filho',
  version: '1.0.0',
  engine: ENGINE,
  dependsOn: { base: '^1.0.0' },
  setup(ctx) {
    ctx.commands.add(command({ name: 'filho', run: (c) => c.reply('filho') }));
  },
});

const statusOf = (b: Bot) =>
  Object.fromEntries(
    b
      .plugins()
      .map((entry) => [entry.name, entry.status === 'loaded' ? 'loaded' : entry.reason.kind]),
  );

describe('bot.plugins.disable / enable (#85)', () => {
  it('desliga o plugin e o comando some; ligando de volta, o comando volta', async () => {
    const transport = new RecordingTransport();
    const b = bot({ transport, storage: createMemoryStorage(), plugins: [base] });
    await b.start();

    const off = await b.plugins.disable('base');
    expect(off.plugin.status).toBe('skipped');
    expect(off.plugin.status === 'skipped' && off.plugin.reason.kind).toBe('disabled');
    transport.emit('message', message('!base'));
    await b.settled();
    expect(sentTexts(transport)).toEqual([]);

    const on = await b.plugins.enable('base');
    expect(on.plugin.status).toBe('loaded');
    transport.emit('message', message('!base'));
    await vi.waitFor(() => expect(sentTexts(transport)).toEqual(['base']));
  });

  it('desligar o provedor deixa o dependente "dependency-skipped"; ligar sobe os dois', async () => {
    const b = bot({
      transport: new RecordingTransport(),
      storage: createMemoryStorage(),
      plugins: [base, filho],
    });
    await b.start();

    const off = await b.plugins.disable('base');
    expect(off.dependents.map((entry) => entry.name)).toEqual(['filho']);
    expect(statusOf(b)).toEqual({ base: 'disabled', filho: 'dependency-skipped' });

    await b.plugins.enable('base');
    expect(statusOf(b)).toEqual({ base: 'loaded', filho: 'loaded' });
  });

  it('desligar de novo ou ligar um plugin já ligado não mexe em nada', async () => {
    const b = bot({
      transport: new RecordingTransport(),
      storage: createMemoryStorage(),
      plugins: [base],
    });
    await b.start();

    const noop = await b.plugins.enable('base');
    expect(noop).toEqual({
      plugin: expect.objectContaining({ name: 'base' }),
      dependents: [],
      teardownErrors: [],
    });
    await b.plugins.disable('base');
    const again = await b.plugins.disable('base');
    expect(again.dependents).toEqual([]);
    expect(statusOf(b)).toEqual({ base: 'disabled' });
  });

  it('plugin desligado não recarrega; "disabled" vale também no boot (disabledPlugins)', async () => {
    const b = bot({
      transport: new RecordingTransport(),
      storage: createMemoryStorage(),
      plugins: [base],
      disabledPlugins: ['base'],
    });
    await b.start();
    expect(statusOf(b)).toEqual({ base: 'disabled' });
    await expect(b.plugins.reload('base')).rejects.toThrow(/plugin ignorado \(desabilitado/);

    await b.plugins.enable('base');
    expect(statusOf(b)).toEqual({ base: 'loaded' });
  });

  it('antes do start, a API de plugins recusa com BotStateError', async () => {
    const b = bot({
      transport: new RecordingTransport(),
      storage: createMemoryStorage(),
      plugins: [base],
    });
    await expect(b.plugins.disable('base')).rejects.toThrow(/plugins ainda não carregados/);
  });
});
