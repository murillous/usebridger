// Métricas do kernel (observadores do ADR 0102), ativos por dia e GET /metrics.

import { command, createHttp, definePlugin, type PluginDefinition } from '@usebridger/core';
import { createTestBot } from '@usebridger/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActiveTracker } from './active.ts';
import { type HistogramRow, type MetricsExporter, type MetricsService, metrics } from './index.ts';
import { renderPrometheus, sanitizeName } from './prometheus.ts';

const DAY = '2026-10-17';
const NEXT = '2026-10-18';
const USER = 'maria@fake';
const GROUP = 'grupo-secreto@fake';

const ping = definePlugin({
  name: 'ping',
  version: '1.0.0',
  engine: '<1.0.0',
  setup(ctx) {
    ctx.commands.add(command({ name: 'ping', run: (c) => c.reply('pong') }));
  },
});

function consumer(exporters: MetricsExporter[] = []): {
  plugin: PluginDefinition;
  get: () => MetricsService;
} {
  let service: MetricsService | undefined;
  const plugin = definePlugin({
    name: 'consumidor',
    version: '1.0.0',
    engine: '<1.0.0',
    dependsOn: { metrics: '*' },
    setup(ctx) {
      service = ctx.services.get('metrics');
      for (const e of exporters) ctx.services.contribute('metrics.exporters', e);
    },
  });
  return {
    plugin,
    get: () => {
      if (!service) throw new Error('serviço não provido');
      return service;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date(`${DAY}T12:00:00Z`));
});
afterEach(() => vi.useRealTimers());

describe('observadores', () => {
  it('message.handled e outbound.sent alimentam contador e histograma sem id pessoal', async () => {
    const { plugin, get } = consumer();
    const bot = await createTestBot({ plugins: [metrics, ping, plugin] });
    await bot.receive({ text: '!ping' });
    await bot.receive({ text: '!ping', chat: { id: GROUP, isGroup: true }, sender: { id: USER } });

    const range = { from: DAY, to: DAY };
    const handled = await get().query('bridger.messages.handled', range);
    expect(handled.map((r) => ({ ...r.labels, v: r.type === 'counter' ? r.value : 0 }))).toEqual(
      expect.arrayContaining([
        { chatType: 'private', route: 'command', status: 'ok', command: 'ping', v: 1 },
        { chatType: 'group', route: 'command', status: 'ok', command: 'ping', v: 1 },
      ]),
    );
    const [duration] = (await get().query(
      'bridger.messages.handle_duration_ms',
      range,
    )) as HistogramRow[];
    expect(duration).toMatchObject({ count: 2, labels: { route: 'command', status: 'ok' } });
    const sent = await get().query('bridger.outbound.sent', range);
    expect(sent.reduce((n, r) => n + (r.type === 'counter' ? r.value : 0), 0)).toBe(2);
    expect(JSON.stringify([handled, sent])).not.toMatch(/maria|grupo-secreto|user@fake/);
    await bot.stop();
  });
});

describe('ativos por dia', () => {
  it('conta ids distintos, soma só o delta entre flushes e troca de dia', async () => {
    const snapshots: string[] = [];
    const { plugin, get } = consumer([(s) => void snapshots.push(JSON.stringify(s))]);
    const bot = await createTestBot({ plugins: [metrics, ping, plugin] });
    const range = { from: DAY, to: NEXT };
    const activeUsers = async (day: string): Promise<number> => {
      const rows = await get().query('bridger.active.users', { from: day, to: day });
      return rows[0]?.type === 'counter' ? rows[0].value : 0;
    };

    await bot.receive({ text: '!ping', chat: { id: GROUP, isGroup: true }, sender: { id: USER } });
    await bot.receive({ text: '!ping', chat: { id: GROUP, isGroup: true }, sender: { id: USER } });
    await bot.receive({ text: '!ping', chat: { id: GROUP, isGroup: true } }); // outro usuário
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000); // segundo flush sem novidade: não soma de novo
    expect(await activeUsers(DAY)).toBe(2);
    const groups = await get().query('bridger.active.groups', range);
    expect(groups).toMatchObject([{ day: DAY, value: 1 }]);

    vi.setSystemTime(new Date(`${NEXT}T00:01:00Z`));
    await bot.receive({ text: '!ping', chat: { id: GROUP, isGroup: true }, sender: { id: USER } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await activeUsers(DAY)).toBe(2);
    expect(await activeUsers(NEXT)).toBe(1); // conjunto novo: o mesmo usuário conta de novo

    const everything = JSON.stringify([
      snapshots,
      await get().query('bridger.active.users', range),
      groups,
    ]);
    expect(everything).not.toMatch(/maria|grupo-secreto|user@fake/);
    await bot.stop();
  });

  it('só guarda HMAC: chave do dia troca na virada e o delta vai para o dia que acabou', () => {
    let now = Date.parse(`${DAY}T23:59:00Z`);
    const calls: [string, number, string][] = [];
    const tracker = createActiveTracker({
      now: () => now,
      add: (m, v, d) => calls.push([m, v, d]),
    });
    tracker.record('a', 'g');
    tracker.record('a', 'g');
    tracker.sync();
    tracker.sync();
    expect(calls).toEqual([
      ['users', 1, DAY],
      ['groups', 1, DAY],
    ]);

    tracker.record('b', undefined);
    now = Date.parse(`${NEXT}T00:00:30Z`);
    tracker.record('a', 'g'); // a virada entrega o delta de 'b' ao dia anterior
    expect(calls.at(-1)).toEqual(['users', 1, DAY]);
    expect(tracker.sizes()).toEqual({ users: 1, groups: 1 });
  });
});

describe('GET /metrics', () => {
  it('expõe contadores, histograma cumulativo e gauges das filas no texto do Prometheus', async () => {
    const http = createHttp({ port: 0, hostname: '127.0.0.1' });
    const bot = await createTestBot({ plugins: [metrics, ping], http });
    await bot.receive({ text: '!ping' });
    await bot.receive({ text: '!ping' });

    const res = await fetch(`http://127.0.0.1:${http.port}/plugins/metrics/metrics`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain; version=0.0.4');
    expect(body).toContain('# TYPE bridger_messages_handled counter');
    expect(body).toContain(
      'bridger_messages_handled{chatType="private",route="command",status="ok",command="ping"} 2',
    );
    expect(body).toContain('# TYPE bridger_messages_handle_duration_ms histogram');
    expect(body).toMatch(
      /bridger_messages_handle_duration_ms_bucket\{route="command",status="ok",le="\+Inf"\} 2/,
    );
    expect(body).toMatch(
      /bridger_messages_handle_duration_ms_count\{route="command",status="ok"\} 2/,
    );
    expect(body).toMatch(
      /bridger_messages_handle_duration_ms_sum\{route="command",status="ok"\} \d/,
    );
    expect(body).toContain('# TYPE bridger_inbound_pending gauge');
    expect(body).toContain('bridger_outbound_pending{priority="normal"} 0');
    expect(body).toContain('bridger_outbound_paused 0');
    expect(body).toContain('bridger_active_users 1');
    expect(body).not.toMatch(/user@fake/);
    await bot.stop();
  });

  it('o acumulado não zera no flush', async () => {
    const http = createHttp({ port: 0, hostname: '127.0.0.1' });
    const bot = await createTestBot({ plugins: [metrics, ping], http });
    await bot.receive({ text: '!ping' });
    await vi.advanceTimersByTimeAsync(60_000);
    const body = await (
      await fetch(`http://127.0.0.1:${http.port}/plugins/metrics/metrics`)
    ).text();
    expect(body).toContain('command="ping"} 1');
    await bot.stop();
  });
});

describe('formato', () => {
  it('sanea nomes e escapa valores de rótulo', () => {
    expect(sanitizeName('bridger.msg-total')).toBe('bridger_msg_total');
    expect(sanitizeName('9x')).toBe('_9x');
    const text = renderPrometheus(
      [{ metric: 'a.b', type: 'counter', day: '', labels: { 'k-1': 'a"b\\c\nd' }, value: 3 }],
      [],
    );
    expect(text).toBe('# TYPE a_b counter\na_b{k_1="a\\"b\\\\c\\nd"} 3\n');
  });

  it('nomes que colidem após o saneamento ficam juntos com um único TYPE', () => {
    const c = (metric: string, value: number) =>
      ({ metric, type: 'counter', day: '', labels: {}, value }) as const;
    const text = renderPrometheus([c('a.b', 1), c('a', 9), c('a_b', 2)], []);
    expect(text).toBe('# TYPE a counter\na 9\n# TYPE a_b counter\na_b 1\na_b 2\n');
  });

  it('tipo diferente após o saneamento é descartado com aviso', () => {
    const skipped: string[] = [];
    const text = renderPrometheus(
      [
        { metric: 'a.b', type: 'counter', day: '', labels: {}, value: 1 },
        {
          metric: 'a_b',
          type: 'histogram',
          day: '',
          labels: {},
          count: 1,
          sum: 1,
          p50: 5,
          p95: 5,
          p99: 5,
          buckets: new Array(13).fill(0),
        },
      ],
      [],
      (n) => skipped.push(n),
    );
    expect(skipped).toEqual(['a_b']);
    expect(text).toBe('# TYPE a_b counter\na_b 1\n');
  });

  it('rótulo le do usuário vira exported_le no histograma', () => {
    const text = renderPrometheus(
      [
        {
          metric: 'h',
          type: 'histogram',
          day: '',
          labels: { le: 'x' },
          count: 1,
          sum: 1,
          p50: 5,
          p95: 5,
          p99: 5,
          buckets: [1, ...new Array(12).fill(0)],
        },
      ],
      [],
    );
    expect(text).toContain('h_bucket{exported_le="x",le="5"} 1');
    expect(text).toContain('h_count{exported_le="x"} 1');
  });
});

describe('fila de saída e dono das métricas', () => {
  it('amostra a fila de saída no flush e dá o dono core às métricas do kernel', async () => {
    const { plugin, get } = consumer();
    const bot = await createTestBot({ plugins: [metrics, ping, plugin] });
    await bot.receive({ text: '!ping' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await get().query('bridger.outbound.pending', { from: DAY, to: DAY })).toMatchObject([
      { type: 'gauge', labels: {}, last: 0, max: 0 },
    ]);
    expect(get().ownerOf('bridger.outbound.pending')).toBe('core');
    expect(get().ownerOf('bridger.outbound.sent')).toBe('core');
    await bot.stop();
  });

  it('o consumidor é dono da métrica que cria', async () => {
    const { plugin, get } = consumer();
    const bot = await createTestBot({ plugins: [metrics, plugin] });
    get().counter('consumidor.x', {});
    expect(get().ownerOf('consumidor.x')).toBe('consumidor');
    await bot.stop();
  });
});
