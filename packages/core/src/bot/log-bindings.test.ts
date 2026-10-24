// ADR 0118: bindings base em toda linha do bot.

import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, type LogDestination } from '#logger/logger.ts';
import { definePlugin } from '#plugin/define.ts';
import { type Bot, type BotConfig, createBot } from './bot.ts';
import { RecordingTransport, recordingLogger } from './harness.test-support.ts';

const bots: Bot[] = [];

afterEach(async () => {
  for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
});

const plugin = definePlugin({
  name: 'eco',
  version: '1.0.0',
  engine: '>=0.0.0',
  setup(ctx) {
    ctx.log.info('pronto');
  },
});

async function start(config: Partial<BotConfig>): Promise<Bot> {
  const bot = createBot({
    transport: new RecordingTransport(),
    env: {},
    plugins: [plugin],
    ...config,
  });
  bots.push(bot);
  await bot.start();
  return bot;
}

describe('bindings base do log (ADR 0118)', () => {
  it('toda linha leva o bot (a sessão), também a do kernel e a do plugin', async () => {
    const logger = recordingLogger();
    await start({ logger, session: 'principal' });
    const ready = logger.lines.find((line) => line.message === 'pronto');
    expect(ready?.fields).toMatchObject({ bot: 'principal', plugin: 'eco' });
    const kernel = logger.lines.find((line) => line.fields['event'] === 'plugin.boot.report');
    expect(kernel?.fields['bot']).toBe('principal');
  });

  it('logBindings acrescenta service, version e env a toda linha', async () => {
    const logger = recordingLogger();
    await start({
      logger,
      logBindings: { service: 'lumabot', version: '0.9.0', env: 'production' },
    });
    for (const line of logger.lines) {
      expect(line.fields).toMatchObject({
        bot: 'default',
        service: 'lumabot',
        version: '0.9.0',
        env: 'production',
      });
    }
    expect(logger.lines.length).toBeGreaterThan(0);
  });

  it('no logger que o bot cria, os bindings saem no JSON antes dos campos da linha', async () => {
    const raw: string[] = [];
    const destination: LogDestination = { write: (line) => raw.push(line) };
    await start({
      logger: createLogger({ destination }),
      session: 'principal',
      logBindings: { service: 'lumabot' },
    });
    const ready = raw
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line['msg'] === 'pronto');
    expect(ready).toMatchObject({
      level: 'info',
      bot: 'principal',
      service: 'lumabot',
      plugin: 'eco',
    });
    expect(Object.keys(ready ?? {}).slice(0, 4)).toEqual(['level', 'time', 'bot', 'service']);
  });
});
