// ADR 0119: bindings `chat`/`sender` pseudonimizados no log da mensagem, e redação de reserva
// no sinal `log` dos observadores.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogSignal } from '#observers/observers.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext } from '#plugin/types.ts';
import { type Bot, createBot } from './bot.ts';
import { message, RecordingTransport, recordingLogger } from './harness.test-support.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const bots: Bot[] = [];

afterEach(async () => {
  for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
});

async function start(setup: (ctx: PluginContext) => void = () => undefined) {
  const logger = recordingLogger();
  const transport = new RecordingTransport();
  let ctx: PluginContext | undefined;
  const plugin = definePlugin({
    name: 'p',
    version: '1.0.0',
    engine: '>=0.0.0',
    setup(c) {
      ctx = c;
      c.events.on('message', (e) => {
        e.log.info('ouvido');
      });
      setup(c);
    },
  });
  const bot = createBot({
    transport,
    logger,
    env: { BRIDGER_SECRET_KEY: KEY },
    plugins: [plugin],
  });
  bots.push(bot);
  await bot.start();
  if (!ctx) throw new Error('setup não rodou');
  return { logger, transport, ctx };
}

describe('bindings chat e sender do log da mensagem (ADR 0119)', () => {
  it('chat e sender são pseudônimos; chat de grupo é g_ e o sender é u_', async () => {
    const { logger, transport, ctx } = await start();
    const group = { ...message('oi'), chat: { id: 'sala@test', isGroup: true } };
    transport.emit('message', group);
    await vi.waitFor(() => expect(logger.lines.some((l) => l.message === 'ouvido')).toBe(true));
    const fields = logger.lines.find((l) => l.message === 'ouvido')?.fields;
    expect(fields?.['chat']).toBe(ctx.pseudonym('sala@test', 'group'));
    expect(fields?.['chat']).toMatch(/^g_/);
    expect(fields?.['sender']).toBe(ctx.pseudonym('user@test'));
    expect(JSON.stringify(logger.lines)).not.toContain('sala@test');
    expect(JSON.stringify(logger.lines)).not.toContain('user@test');
  });

  it('chat privado leva u_', async () => {
    const { logger, transport } = await start();
    transport.emit('message', message('oi'));
    await vi.waitFor(() => expect(logger.lines.some((l) => l.message === 'ouvido')).toBe(true));
    expect(logger.lines.find((l) => l.message === 'ouvido')?.fields['chat']).toMatch(/^u_/);
  });

  it('ctx.pseudonym sem kind usa o formato do id (grupo do WhatsApp vira g_)', async () => {
    const { ctx } = await start();
    expect(ctx.pseudonym('120363@g.us')).toMatch(/^g_/);
    expect(ctx.pseudonym('5511999998888@s.whatsapp.net')).toMatch(/^u_/);
  });
});

describe('sinal log sem JID nem telefone (ADR 0119)', () => {
  it('JID no campo e na mensagem, e telefone no erro, chegam redigidos ao observador', async () => {
    const lines: LogSignal[] = [];
    await start((ctx) => {
      ctx.observe('log', (signal) => lines.push(signal));
      ctx.log.warn('enviando para 5511999998888@s.whatsapp.net', {
        jid: '5511999998888@s.whatsapp.net',
        addr: '5511999998888.0',
        err: new Error('falhou 123456789@lid'),
      });
    });
    const line = lines.find((l) => l.message.startsWith('enviando'));
    expect(line).toBeDefined();
    const text = JSON.stringify(line);
    expect(text).not.toMatch(/@s\.whatsapp\.net|@lid|5511999998888/);
    expect(text).toContain('[REDACTED]');
  });
});
