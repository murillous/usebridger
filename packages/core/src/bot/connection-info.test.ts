// ADR 0111: horário de conexão, reconexões e expiração do QR no contexto do plugin.

import { afterEach, describe, expect, it } from 'vitest';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext } from '#plugin/types.ts';
import { type Bot, createBot } from './bot.ts';
import { createConnectionTracker } from './connection-info.ts';
import { RecordingTransport, recordingLogger } from './harness.test-support.ts';

describe('createConnectionTracker', () => {
  it('conta reconexões e zera o horário na queda', () => {
    let t = 100;
    const tracker = createConnectionTracker(() => t);
    expect(tracker.info()).toEqual({
      connectedSince: undefined,
      reconnections: 0,
      qrExpiresAt: undefined,
    });
    tracker.onStatus({ status: 'open' });
    expect(tracker.info()).toMatchObject({ connectedSince: 100, reconnections: 0 });
    t = 200;
    tracker.onStatus({ status: 'open' });
    expect(tracker.info()).toMatchObject({ connectedSince: 100, reconnections: 0 });
    tracker.onStatus({ status: 'closed', reason: 'connection-lost', error: null });
    expect(tracker.info().connectedSince).toBeUndefined();
    t = 300;
    tracker.onStatus({ status: 'open' });
    expect(tracker.info()).toMatchObject({ connectedSince: 300, reconnections: 1 });
  });

  it('open, connecting, open conta reconexão e renova o horário', () => {
    let t = 100;
    const tracker = createConnectionTracker(() => t);
    tracker.onStatus({ status: 'open' });
    t = 200;
    tracker.onStatus({ status: 'connecting' });
    expect(tracker.info().connectedSince).toBeUndefined();
    t = 300;
    tracker.onStatus({ status: 'open' });
    expect(tracker.info()).toMatchObject({ connectedSince: 300, reconnections: 1 });
  });

  it('QR guarda a expiração até abrir ou cair', () => {
    const tracker = createConnectionTracker();
    tracker.onQr(5000);
    expect(tracker.info().qrExpiresAt).toBe(5000);
    tracker.onQr(undefined);
    expect(tracker.info().qrExpiresAt).toBeUndefined();
    tracker.onQr(5000);
    tracker.onStatus({ status: 'open' });
    expect(tracker.info().qrExpiresAt).toBeUndefined();
  });
});

const bots: Bot[] = [];
afterEach(async () => {
  for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
});

async function start(name?: string) {
  const transport = new RecordingTransport();
  let ctx: PluginContext | undefined;
  const plugin = definePlugin({
    name: 'sonda',
    version: '1.0.0',
    engine: '>=0.0.0',
    setup(c) {
      ctx = c as PluginContext;
    },
  });
  const bot = createBot({
    transport,
    plugins: [plugin],
    logger: recordingLogger(),
    ...(name !== undefined && { name }),
  });
  bots.push(bot);
  await bot.start();
  if (ctx === undefined) throw new Error('setup não rodou');
  return { ctx, transport };
}

describe('ctx.connectionInfo() e ctx.botName', () => {
  it('botName é o configurado ou, sem config, o nome do transport', async () => {
    const { ctx, transport } = await start();
    expect(ctx.botName).toBe(transport.name);
    expect((await start('luma')).ctx.botName).toBe('luma');
  });

  it('acompanha o open, a queda, a reconexão e o QR com expiração', async () => {
    const { ctx, transport } = await start();
    expect(ctx.connectionInfo().connectedSince).toEqual(expect.any(Number));
    expect(ctx.connectionInfo().reconnections).toBe(0);
    transport.emit('connection.status', {
      status: 'closed',
      reason: 'connection-lost',
      error: null,
    });
    transport.emit('connection.qr', { qr: 'QR', expiresAt: 123 });
    expect(ctx.connectionInfo()).toEqual({
      connectedSince: undefined,
      reconnections: 0,
      qrExpiresAt: 123,
    });
    transport.emit('connection.status', { status: 'open' });
    expect(ctx.connectionInfo()).toMatchObject({ reconnections: 1, qrExpiresAt: undefined });
  });
});
