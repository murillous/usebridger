// ADR 0119: pseudônimo estável nos logs do bot e `ctx.pseudonym` para plugins.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext } from '#plugin/types.ts';
import { type Bot, type BotConfig, createBot } from './bot.ts';
import { message, RecordingTransport, recordingLogger } from './harness.test-support.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const bots: Bot[] = [];

afterEach(async () => {
  for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
});

async function run(env: Record<string, string>, config: Partial<BotConfig> = {}) {
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
    },
  });
  const bot = createBot({ transport, logger, env, plugins: [plugin], ...config });
  bots.push(bot);
  await bot.start();
  transport.emit('message', message('oi', { chatId: '5511999998888@s.whatsapp.net' }));
  await vi.waitFor(() => expect(logger.lines.some((l) => l.message === 'ouvido')).toBe(true));
  const heard = logger.lines.find((l) => l.message === 'ouvido');
  if (!ctx) throw new Error('setup não rodou');
  return { logger, ctx, chat: heard?.fields['chat'], bot };
}

describe('pseudônimo nos logs do bot (ADR 0119)', () => {
  it('o binding chat é pseudônimo e é o mesmo entre restarts com a mesma chave mestra', async () => {
    const first = await run({ BRIDGER_SECRET_KEY: KEY });
    await first.bot.stop();
    const second = await run({ BRIDGER_SECRET_KEY: KEY });
    expect(first.chat).toMatch(/^u_[\w-]{22}$/);
    expect(second.chat).toBe(first.chat);
    expect(JSON.stringify(first.logger.lines)).not.toContain('5511999998888');
  });

  it('outra chave mestra muda o pseudônimo', async () => {
    const a = await run({ BRIDGER_SECRET_KEY: KEY });
    const b = await run({ BRIDGER_SECRET_KEY: Buffer.alloc(32, 9).toString('base64') });
    expect(b.chat).not.toBe(a.chat);
  });

  it('ctx.pseudonym dá o mesmo valor que o log e diferencia usuário de grupo', async () => {
    const { ctx, chat } = await run({ BRIDGER_SECRET_KEY: KEY });
    expect(ctx.pseudonym('5511999998888@s.whatsapp.net')).toBe(chat);
    expect(ctx.pseudonym('5511999998888@s.whatsapp.net', 'group')).toMatch(/^g_/);
    expect(ctx.pseudonym('outro@lid')).not.toBe(chat);
  });

  it('sem chave mestra avisa, uma vez, que os pseudônimos são efêmeros', async () => {
    const { logger } = await run({});
    const warned = logger.lines.filter((l) => l.fields['event'] === 'bot.pseudonym.ephemeral');
    expect(warned).toHaveLength(1);
    const withKey = await run({ BRIDGER_SECRET_KEY: KEY });
    expect(
      withKey.logger.lines.filter((l) => l.fields['event'] === 'bot.pseudonym.ephemeral'),
    ).toHaveLength(0);
  });
});
