// ADR 0120: `trace` por unidade de trabalho e trilha de eventos (#232).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { command } from '#commands/command.ts';
import { createHttp } from '#http/server.ts';
import { createLogger } from '#logger/logger.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext } from '#plugin/types.ts';
import { formatTraceparent, newTraceId, parseTraceparent } from '#trace/scope.ts';
import { type Bot, type BotConfig, createBot } from './bot.ts';
import { message, RecordingTransport } from './harness.test-support.ts';

const ENGINE = '>=0.0.0';
const TRACE = /^[0-9a-f]{32}$/;
const bots: Bot[] = [];

afterEach(async () => {
  for (const created of bots.splice(0)) await created.stop().catch(() => undefined);
});

type Line = Record<string, unknown>;

/** Bot com logger real do core (o `trace` entra pelo `mixin`) e as linhas JSON capturadas. */
async function start(
  setup: (ctx: PluginContext) => void,
  config: Partial<BotConfig> = {},
  level: 'info' | 'trace' = 'info',
) {
  const lines: Line[] = [];
  const transport = new RecordingTransport();
  const logger = createLogger({
    level,
    destination: { write: (line) => lines.push(JSON.parse(line) as Line) },
  });
  const created = createBot({
    transport,
    logger,
    outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
    env: {},
    plugins: [definePlugin({ name: 'p', version: '1.0.0', engine: ENGINE, setup })],
    ...config,
  });
  bots.push(created);
  await created.start();
  return { lines, transport, bot: created };
}

const byEvent = (lines: Line[], event: string): Line[] => lines.filter((l) => l['event'] === event);

describe('trace por mensagem', () => {
  it('é o mesmo do recebimento ao envio e ao log do plugin, e muda a cada mensagem', async () => {
    const { lines, transport, bot } = await start((ctx) => {
      ctx.commands.add(
        command({
          name: 'eco',
          run: async (c) => {
            ctx.log.info('dentro do comando');
            await c.reply('resposta');
          },
        }),
      );
    });
    transport.emit('message', message('!eco'));
    transport.emit('message', message('!eco', { chatId: 'outro@test' }));
    await vi.waitFor(() => expect(byEvent(lines, 'outbound.sent')).toHaveLength(2));
    await bot.settled();

    const [first, second] = byEvent(lines, 'message.received').map((l) => l['trace']);
    expect(first).toMatch(TRACE);
    expect(second).toMatch(TRACE);
    expect(first).not.toBe(second);
    const ofFirst = lines.filter((l) => l['trace'] === first).map((l) => l['event'] ?? l['msg']);
    expect(ofFirst).toEqual(
      expect.arrayContaining([
        'message.received',
        'dentro do comando',
        'outbound.sent',
        'message.handled',
      ]),
    );
    const handled = byEvent(lines, 'message.handled').find((l) => l['trace'] === first);
    expect(handled).toMatchObject({ route: 'command', command: 'eco', status: 'ok' });
    expect(typeof handled?.['durationMs']).toBe('number');
  });

  it('nenhum texto de mensagem sai, nem em debug', async () => {
    const { lines, transport, bot } = await start(
      (ctx) => {
        ctx.commands.add(command({ name: 'eco', run: (c) => c.reply('resposta-sigilosa') }));
        ctx.events.on('message', () => undefined);
      },
      { trail: 'debug' },
      'trace',
    );
    transport.emit('message', message('!eco texto-sigiloso'));
    await vi.waitFor(() => expect(byEvent(lines, 'outbound.sent')).toHaveLength(1));
    await bot.settled();

    expect(byEvent(lines, 'message.received')[0]).toMatchObject({ level: 'debug', kind: 'text' });
    const all = JSON.stringify(lines);
    expect(all).not.toContain('texto-sigiloso');
    expect(all).not.toContain('resposta-sigilosa');
  });

  it("trail: 'off' silencia a trilha e não afeta os erros", async () => {
    const { lines, transport, bot } = await start(
      (ctx) => {
        ctx.commands.add(
          command({
            name: 'quebra',
            run: () => {
              throw new Error('falhou');
            },
          }),
        );
      },
      { trail: 'off' },
    );
    transport.emit('message', message('!quebra'));
    await vi.waitFor(() => expect(byEvent(lines, 'plugin.failed').length).toBeGreaterThan(0));
    await bot.settled();

    for (const name of ['message.received', 'message.handled', 'outbound.sent']) {
      expect(byEvent(lines, name)).toHaveLength(0);
    }
    // O erro sai no trace da mensagem.
    expect(byEvent(lines, 'plugin.failed')[0]?.['trace']).toMatch(TRACE);
  });

  it("trail: 'debug' com o logger em info não emite a trilha", async () => {
    const { lines, transport, bot } = await start(() => undefined, { trail: 'debug' });
    transport.emit('message', message('oi'));
    await bot.settled();
    expect(byEvent(lines, 'message.received')).toHaveLength(0);
    expect(byEvent(lines, 'message.handled')).toHaveLength(0);
  });

  it('o sinal log leva o trace nos fields', async () => {
    const seen: unknown[] = [];
    const { transport, bot } = await start((ctx) => {
      ctx.observe('log', (signal) => {
        if (signal.fields['event'] === 'message.received') seen.push(signal.fields['trace']);
      });
    });
    transport.emit('message', message('oi'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await bot.settled();
    expect(seen[0]).toMatch(TRACE);
  });
});

describe('trace do job', () => {
  it('o job ganha trace próprio e guarda o da mensagem como cause', async () => {
    const { lines, transport, bot } = await start((ctx) => {
      ctx.scheduler.on('depois', () => {
        ctx.log.info('job rodando');
      });
      ctx.commands.add(
        command({
          name: 'agenda',
          run: async () => {
            await ctx.scheduler.at(Date.now() + 5, 'depois');
          },
        }),
      );
    });
    transport.emit('message', message('!agenda'));
    await vi.waitFor(() => expect(byEvent(lines, 'job.run')).toHaveLength(1));
    await bot.settled();

    const [received] = byEvent(lines, 'message.received');
    const [run] = byEvent(lines, 'job.run');
    expect(run).toMatchObject({
      job: 'depois',
      plugin: 'p',
      status: 'ok',
      cause: received?.['trace'],
    });
    expect(run?.['trace']).toMatch(TRACE);
    expect(run?.['trace']).not.toBe(received?.['trace']);
    // O log do plugin dentro do job sai no trace do job.
    expect(lines.find((l) => l['msg'] === 'job rodando')?.['trace']).toBe(run?.['trace']);
  });
});

describe('traceparent no HTTP', () => {
  async function withRoute() {
    const http = createHttp({ port: 0, hostname: '127.0.0.1' });
    const started = await start(
      (ctx) => {
        ctx.http.route('GET', '/ping', () => {
          ctx.log.info('no handler');
          return new Response('pong');
        });
      },
      { http },
    );
    const fetchPing = (headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${http.port}/plugins/p/ping?segredo=1`, { headers });
    return { ...started, fetchPing };
  }

  it('aceita o traceparent de entrada, devolve o header e usa o trace nos logs', async () => {
    const { lines, fetchPing } = await withRoute();
    const incoming = '4bf92f3577b34da6a3ce929d0e0e4736';
    const response = await fetchPing({ traceparent: `00-${incoming}-00f067aa0ba902b7-01` });

    expect(response.status).toBe(200);
    expect(parseTraceparent(response.headers.get('traceparent'))).toBe(incoming);
    expect(lines.find((l) => l['msg'] === 'no handler')?.['trace']).toBe(incoming);
    const [request] = byEvent(lines, 'http.request');
    expect(request).toMatchObject({
      trace: incoming,
      method: 'GET',
      route: '/plugins/p/ping',
      status: 200,
    });
    // Sem query string nem corpo na trilha.
    expect(JSON.stringify(lines)).not.toContain('segredo=1');
  });

  it.each([
    ['ausente', undefined],
    ['malformado', 'lixo'],
    ['zerado', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`],
  ])('traceparent %s: gera um trace e o devolve', async (_name, header) => {
    const { lines, fetchPing } = await withRoute();
    const response = await fetchPing(header === undefined ? {} : { traceparent: header });
    const trace = parseTraceparent(response.headers.get('traceparent'));
    expect(trace).toMatch(TRACE);
    expect(byEvent(lines, 'http.request')[0]?.['trace']).toBe(trace);
  });
});

describe('trace: unidade', () => {
  it('formata e lê o traceparent', () => {
    const trace = newTraceId();
    expect(trace).toMatch(TRACE);
    expect(parseTraceparent(formatTraceparent(trace))).toBe(trace);
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(
      parseTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'),
    ).toBeUndefined();
    expect(parseTraceparent(`00-${trace}-${'0'.repeat(16)}-01`)).toBeUndefined();
  });

  it('recusa trail inválido', () => {
    expect(() => createBot({ transport: new RecordingTransport(), trail: 'x' as never })).toThrow(
      TypeError,
    );
  });
});
