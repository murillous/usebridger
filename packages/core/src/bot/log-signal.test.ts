// ADR 0109 (#152): sinal `log` dos observadores.

import { afterEach, describe, expect, it } from 'vitest';
import type { PluginErrorEvent } from '#events/types.ts';
import { createNoopLogger } from '#logger/logger.ts';
import { createSecretSet } from '#logger/secrets.ts';
import type { Logger, LogLevel } from '#logger/types.ts';
import type { LogSignal } from '#observers/observers.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext } from '#plugin/types.ts';
import { type Bot, type BotConfig, createBot } from './bot.ts';
import { RecordingTransport, recordingLogger } from './harness.test-support.ts';

const bots: Bot[] = [];

afterEach(async () => {
  for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
});

async function startBot(
  setup: (ctx: PluginContext) => void,
  config: Partial<BotConfig> = {},
): Promise<{ bot: Bot; errors: PluginErrorEvent[] }> {
  const errors: PluginErrorEvent[] = [];
  const plugin = definePlugin({
    name: 'p',
    version: '1.0.0',
    engine: '>=0.0.0',
    setup(ctx) {
      ctx.events.on('plugin.error', (e) => {
        errors.push(e.payload);
      });
      setup(ctx);
    },
  });
  const bot = createBot({
    transport: new RecordingTransport(),
    logger: recordingLogger(),
    env: {},
    ...config,
    plugins: [plugin, ...(config.plugins ?? [])],
  });
  bots.push(bot);
  await bot.start();
  return { bot, errors };
}

describe('ctx.observe("log") (ADR 0109)', () => {
  it('entrega a linha do plugin com bindings do filho, nível e hora', async () => {
    const lines: LogSignal[] = [];
    const before = Date.now();
    await startBot((ctx) => {
      ctx.observe('log', (signal) => lines.push(signal));
      ctx.log.child({ chatId: 'c1' }).warn('oi', { n: 1 });
    });
    const line = lines.find((l) => l.message === 'oi');
    expect(line).toMatchObject({ level: 'warn', fields: { n: 1, chatId: 'c1' } });
    expect(line?.fields['plugin']).toBe('p');
    expect(line?.time).toBeGreaterThanOrEqual(before);
  });

  it('respeita o nível do logger: o que ele descarta não vira sinal', async () => {
    const lines: LogSignal[] = [];
    const withLevel = (inner: Logger): Logger => ({
      ...inner,
      level: 'warn' as LogLevel,
      child: (bindings) => withLevel(inner.child(bindings)),
    });
    const logger = withLevel(recordingLogger());
    await startBot(
      (ctx) => {
        ctx.observe('log', (signal) => lines.push(signal));
        ctx.log.info('abaixo');
        ctx.log.error('acima');
      },
      { logger },
    );
    expect(lines.map((l) => l.message)).toEqual(['acima']);
  });

  it('mascara secrets na mensagem, nos campos e no erro', async () => {
    const secrets = createSecretSet();
    secrets.set('app', ['s3cr3t-token']);
    const lines: LogSignal[] = [];
    await startBot(
      (ctx) => {
        ctx.observe('log', (signal) => lines.push(signal));
        ctx.log.error('falha s3cr3t-token', {
          url: 'x?k=s3cr3t-token',
          err: new Error('boom s3cr3t-token'),
        });
      },
      { secrets },
    );
    const line = lines.find((l) => l.message.startsWith('falha'));
    expect(line).toBeDefined();
    expect(JSON.stringify(line)).not.toContain('s3cr3t-token');
    expect(JSON.stringify(line)).toContain('[REDACTED]');
  });

  it('log feito dentro do observador, e o plugin.error dele, não volta ao sinal', async () => {
    let calls = 0;
    const { errors } = await startBot((ctx) => {
      ctx.observe('log', () => {
        calls += 1;
        ctx.log.info('dentro do observador');
        throw new Error('observador quebrou');
      });
      ctx.log.info('gatilho');
    });
    // Uma chamada por linha externa; nenhuma pela linha do observador nem pelo plugin.error.
    const afterBoot = calls;
    expect(errors.every((e) => e.phase === 'observer' && e.event === 'log')).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    expect(afterBoot).toBe(errors.length);
  });

  it('observador async que rejeita não entra em laço', async () => {
    let calls = 0;
    await startBot((ctx) => {
      ctx.observe('log', async () => {
        calls += 1;
        throw new Error('async quebrou');
      });
      ctx.log.info('gatilho');
    });
    await new Promise((resolve) => setImmediate(resolve));
    const settled = calls;
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(settled);
  });

  it('sem observador de log não lê os campos da linha', async () => {
    let read = 0;
    const fields = {
      get x() {
        read += 1;
        return 1;
      },
    };
    const logger = { ...createNoopLogger(), level: 'trace' as LogLevel, info: () => undefined };
    await startBot((ctx) => ctx.log.info('sem observador', fields), { logger });
    expect(read).toBe(0);
  });

  it('observador async que loga depois de await não gera sinal novo', async () => {
    let calls = 0;
    await startBot((ctx) => {
      ctx.observe('log', async () => {
        calls += 1;
        await Promise.resolve();
        ctx.log.info('depois do await');
      });
      ctx.log.info('gatilho');
    });
    await new Promise((resolve) => setImmediate(resolve));
    const settled = calls;
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(settled);
  });

  it('listener de plugin.error que loga após await não reentra', async () => {
    let calls = 0;
    await startBot((ctx) => {
      ctx.events.on('plugin.error', async () => {
        await Promise.resolve();
        ctx.log.warn('depois do erro');
      });
      ctx.observe('log', () => {
        calls += 1;
        throw new Error('sempre falha');
      });
      ctx.log.info('gatilho');
    });
    await new Promise((resolve) => setImmediate(resolve));
    const settled = calls;
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(settled);
  });

  it('serializa tipos especiais: bigint, Date, buffer, Map, Set e props do Error', async () => {
    const lines: LogSignal[] = [];
    await startBot((ctx) => {
      ctx.observe('log', (signal) => lines.push(signal));
      const err = Object.assign(new Error('e'), { code: 'E_X' });
      ctx.log.info('tipos', {
        n: 10n,
        d: new Date(0),
        b: Buffer.alloc(3),
        m: new Map([['k', 1]]),
        s: new Set([1]),
        err,
      });
    });
    const line = lines.find((l) => l.message === 'tipos');
    expect(() => JSON.stringify(line)).not.toThrow();
    expect(line?.fields).toMatchObject({
      n: '10',
      d: '1970-01-01T00:00:00.000Z',
      b: '[Buffer 3 bytes]',
      m: { k: 1 },
      s: [1],
      err: { type: 'Error', message: 'e', code: 'E_X' },
    });
  });

  it('depois do dispose do plugin o observador some', async () => {
    const lines: string[] = [];
    let log: PluginContext['log'] | undefined;
    const outro = definePlugin({
      name: 'outro',
      version: '1.0.0',
      engine: '>=0.0.0',
      setup(ctx) {
        ctx.observe('log', (signal) => lines.push(signal.message));
      },
    });
    const { bot } = await startBot(
      (ctx) => {
        log = ctx.log;
      },
      { plugins: [outro] },
    );
    log?.info('antes');
    await bot.plugins.disable('outro');
    log?.info('depois');
    expect(lines).toContain('antes');
    expect(lines).not.toContain('depois');
  });

  it('config.logger com level silent não emite sinal', async () => {
    const lines: LogSignal[] = [];
    const silent = (inner: Logger): Logger => ({
      ...inner,
      level: 'silent' as LogLevel,
      child: (bindings) => silent(inner.child(bindings)),
    });
    const logger = silent(recordingLogger());
    await startBot(
      (ctx) => {
        ctx.observe('log', (signal) => lines.push(signal));
        ctx.log.error('muda');
      },
      { logger },
    );
    expect(lines).toEqual([]);
  });

  it('campo com getter que lança não faz o log lançar e o sinal vai com o fallback', async () => {
    const lines: LogSignal[] = [];
    let threw = false;
    // Logger que ignora os campos: o que se testa é a montagem do sinal, não o logger do app.
    const blind = (): Logger => ({
      ...createNoopLogger(),
      level: 'trace' as LogLevel,
      info: () => undefined,
      child: blind,
    });
    const logger = blind();
    await startBot(
      (ctx) => {
        ctx.observe('log', (signal) => lines.push(signal));
        const fields = {
          get ruim(): never {
            throw new Error('getter');
          },
        };
        try {
          ctx.log.info('getter', fields);
        } catch {
          threw = true;
        }
      },
      { logger },
    );
    expect(threw).toBe(false);
    expect(lines.find((l) => l.message === 'getter')?.fields).toEqual({ unserializable: true });
  });
});
