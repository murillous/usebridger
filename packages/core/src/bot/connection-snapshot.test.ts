// ADR 0106: `ctx.session` e o último `ConnectionStatus` no contexto do plugin.

import { afterEach, describe, expect, it } from 'vitest';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext } from '#plugin/types.ts';
import { type Bot, createBot } from './bot.ts';
import { RecordingTransport, recordingLogger } from './harness.test-support.ts';

const bots: Bot[] = [];
afterEach(async () => {
  for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
});

async function start(session?: string) {
  const transport = new RecordingTransport();
  let ctx: PluginContext | undefined;
  // O snapshot visto no setup: o plugin sobe antes do connect(), logo antes de qualquer evento.
  let atSetup: unknown = 'não rodou';
  const plugin = definePlugin({
    name: 'sonda',
    version: '1.0.0',
    engine: '>=0.0.0',
    setup(c) {
      ctx = c as PluginContext;
      atSetup = c.connectionStatus();
    },
  });
  const bot = createBot({
    transport,
    plugins: [plugin],
    logger: recordingLogger(),
    ...(session !== undefined && { session }),
  });
  bots.push(bot);
  await bot.start();
  if (ctx === undefined) throw new Error('setup não rodou');
  return { ctx, transport, atSetup };
}

describe('ctx.session', () => {
  it('é default sem config e o nome configurado com ela', async () => {
    expect((await start()).ctx.session).toBe('default');
    expect((await start('loja')).ctx.session).toBe('loja');
  });
});

describe('ctx.connectionStatus()', () => {
  it('é undefined antes do primeiro evento', async () => {
    expect((await start()).atSetup).toBeUndefined();
  });

  it('guarda o último status: open no boot, depois closed', async () => {
    const { ctx, transport } = await start();
    expect(ctx.connectionStatus()).toEqual({ status: 'open' });
    const closed = { status: 'closed', reason: 'connection-lost', error: new Error('x') } as const;
    transport.emit('connection.status', closed);
    expect(ctx.connectionStatus()).toBe(closed);
  });
});
