// provideScoped no contexto: recusado depois do dispose e limpeza completa quando o release lança.

import { afterEach, describe, expect, it } from 'vitest';
import { command } from '#commands/command.ts';
import { definePlugin } from '#plugin/define.ts';
import { PluginHostStateError } from '#plugin/host.ts';
import { type Bot, type BotConfig, createBot } from './bot.ts';
import { deferred, message, RecordingTransport, recordingLogger } from './harness.test-support.ts';

const ENGINE = '>=0.0.0';

declare module '@usebridger/core' {
  interface Services {
    'test.escopo': string;
  }
}

const bots: Bot[] = [];
function bot(config: Partial<BotConfig> & Pick<BotConfig, 'transport'>): Bot {
  const created = createBot({
    logger: recordingLogger(),
    env: {},
    outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
    ...config,
  });
  bots.push(created);
  return created;
}
afterEach(async () => {
  for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
});

describe('provideScoped', () => {
  it('o contexto recusa provideScoped depois do dispose (setup que estourou o prazo)', async () => {
    const transport = new RecordingTransport();
    const gate = deferred();
    const late: unknown[] = [];
    const lento = definePlugin({
      name: 'lento',
      version: '1.0.0',
      engine: ENGINE,
      async setup(ctx) {
        await gate.promise;
        try {
          ctx.services.provideScoped('test.escopo', () => 'x');
        } catch (error) {
          late.push(error);
        }
      },
    });
    const b = bot({ transport, plugins: [lento], timeouts: { setupMs: 10 } });
    await expect(b.start()).rejects.toMatchObject({ name: 'PluginBootError' });
    gate.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(late).toHaveLength(1);
    expect(late[0]).toBeInstanceOf(PluginHostStateError);
  });

  it('release que lança não deixa sobras: o reload do caller recarrega e o resto do dispose roda', async () => {
    const transport = new RecordingTransport();
    const provedor = definePlugin({
      name: 'provedor',
      version: '1.0.0',
      engine: ENGINE,
      setup(ctx) {
        ctx.services.provideScoped(
          'test.escopo',
          (caller) => caller,
          () => {
            throw new Error('release quebrou');
          },
        );
      },
    });
    const observed: string[] = [];
    const consumidor = definePlugin({
      name: 'consumidor',
      version: '1.0.0',
      engine: ENGINE,
      dependsOn: { provedor: '*' },
      setup(ctx) {
        ctx.services.get('test.escopo');
        ctx.commands.add(command({ name: 'oi', run: (c) => c.reply('oi') }));
        ctx.observe('outbound.sent', (s) => void observed.push(s.status));
      },
    });
    const b = bot({ transport, plugins: [provedor, consumidor] });
    await b.start();
    await b.plugins.reload('consumidor');

    // O plugin voltou sem conflito, com comando e observer um só (o dispose antigo terminou tudo).
    expect(b.plugins().find((p) => p.name === 'consumidor')?.status).toBe('loaded');
    transport.emit('message', message('!oi'));
    await new Promise((r) => setTimeout(r, 20));
    expect(observed).toEqual(['sent']);
    expect(transport.sent).toHaveLength(1);
  });
});
