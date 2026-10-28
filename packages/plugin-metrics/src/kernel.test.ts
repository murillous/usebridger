// Métricas do kernel (observadores do ADR 0102), ativos por dia e GET /metrics.

import { command, createHttp, definePlugin, type PluginDefinition } from '@usebridger/core';
import { createTestBot } from '@usebridger/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActiveTracker } from './active.ts';
import { createPeriods } from './history.ts';
import { type MetricsService, metrics } from './index.ts';

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

// Consumidor que declara uma métrica no setup, como um app faria.
function consumer(): { plugin: PluginDefinition; get: () => MetricsService } {
  let service: MetricsService | undefined;
  const plugin = definePlugin({
    name: 'consumidor',
    version: '1.0.0',
    engine: '<1.0.0',
    dependsOn: { metrics: '*' },
    setup(ctx) {
      service = ctx.services.get('metrics');
      service.counter({ name: 'consumidor_x_total', help: 'x', labelNames: [] }).inc({});
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

async function scrape(port: number | undefined): Promise<{ res: Response; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/plugins/metrics/metrics`);
  return { res, body: await res.text() };
}

afterEach(() => vi.useRealTimers());

describe('GET /metrics', () => {
  it('expõe as três métricas do kernel e os gauges ao vivo com HELP/TYPE, sem id pessoal', async () => {
    const http = createHttp({ port: 0, hostname: '127.0.0.1' });
    const bot = await createTestBot({ plugins: [metrics, ping], http });
    await bot.receive({ text: '!ping' });
    await bot.receive({ text: '!ping', chat: { id: GROUP, isGroup: true }, sender: { id: USER } });

    const { res, body } = await scrape(http.port);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain; version=0.0.4');
    for (const [name, type] of [
      ['bridger_messages_handled_total', 'counter'],
      ['bridger_message_handle_duration_seconds', 'histogram'],
      ['bridger_outbound_sent_total', 'counter'],
      ['bridger_inbound_pending', 'gauge'],
      ['bridger_inbound_active_chats', 'gauge'],
      ['bridger_outbound_pending', 'gauge'],
      ['bridger_outbound_in_flight', 'gauge'],
      ['bridger_outbound_paused', 'gauge'],
      ['bridger_active_users', 'gauge'],
      ['bridger_active_groups', 'gauge'],
    ]) {
      expect(body).toMatch(new RegExp(`# HELP ${name} .+\\n# TYPE ${name} ${type}`));
    }
    expect(body).toContain(
      'bridger_messages_handled_total{chatType="private",route="command",status="ok",command="ping"} 1',
    );
    expect(body).toContain(
      'bridger_messages_handled_total{chatType="group",route="command",status="ok",command="ping"} 1',
    );
    expect(body).toContain(
      'bridger_message_handle_duration_seconds_bucket{le="30",route="command",status="ok"} 2',
    );
    expect(body).toContain(
      'bridger_message_handle_duration_seconds_count{route="command",status="ok"} 2',
    );
    expect(body).toContain(
      'bridger_outbound_sent_total{kind="text",status="sent",chatType="private"} 1',
    );
    expect(body).toContain('bridger_outbound_pending{priority="normal"} 0');
    expect(body).toContain('bridger_outbound_paused 0');
    expect(body).toContain('bridger_active_users 2');
    expect(body).toContain('bridger_active_groups 1');
    expect(body).not.toMatch(/maria|grupo-secreto|user@fake/);
    await bot.stop();
  });

  it('dois bots no mesmo processo têm registries isoladas', async () => {
    const httpA = createHttp({ port: 0, hostname: '127.0.0.1' });
    const httpB = createHttp({ port: 0, hostname: '127.0.0.1' });
    const a = await createTestBot({ plugins: [metrics, ping], http: httpA });
    const b = await createTestBot({ plugins: [metrics, ping], http: httpB });
    await a.receive({ text: '!ping' });
    await a.receive({ text: '!ping' });
    await b.receive({ text: '!ping' });
    expect((await scrape(httpA.port)).body).toContain('command="ping"} 2');
    expect((await scrape(httpB.port)).body).toContain('command="ping"} 1');
    await a.stop();
    await b.stop();
  });

  it('reload do consumidor tira a métrica dele e a redeclaração a traz de volta zerada', async () => {
    const http = createHttp({ port: 0, hostname: '127.0.0.1' });
    const { plugin, get } = consumer();
    const bot = await createTestBot({ plugins: [metrics, plugin], http });
    const handle = get().counter({ name: 'consumidor_x_total', help: 'x', labelNames: [] });
    handle.inc({}, 4);
    expect((await scrape(http.port)).body).toContain('consumidor_x_total 5');

    await bot.bot.plugins.reload('consumidor');
    expect((await scrape(http.port)).body).toContain('consumidor_x_total 1');
    await bot.stop();
  });

  it('o consumidor não declara nome de gauge ao vivo do kernel', async () => {
    const { plugin, get } = consumer();
    const bot = await createTestBot({ plugins: [metrics, plugin] });
    expect(() =>
      get().gauge({ name: 'bridger_inbound_pending', help: 'x', labelNames: [] }),
    ).toThrow(TypeError);
    await bot.stop();
  });
});

describe('ativos por dia', () => {
  it('conta ids distintos e recomeça com chave nova na virada', () => {
    let now = Date.parse('2026-10-17T23:59:00Z');
    const tracker = createActiveTracker({ now: () => now });
    tracker.record('a', 'g');
    tracker.record('a', 'g');
    tracker.record('b', undefined);
    expect(tracker.sizes()).toEqual({ users: 2, groups: 1 });

    now = Date.parse('2026-10-18T00:00:30Z');
    expect(tracker.sizes()).toEqual({ users: 0, groups: 0 });
    tracker.record('a', undefined); // conjunto novo: o mesmo usuário conta de novo
    expect(tracker.sizes()).toEqual({ users: 1, groups: 0 });
  });

  it('vira o dia pelo dayOf (fuso do histórico)', () => {
    let now = Date.parse('2026-10-18T02:59:00Z'); // 23:59 em São Paulo
    const periods = createPeriods('America/Sao_Paulo');
    const tracker = createActiveTracker({ now: () => now, dayOf: (ms) => periods(ms).day });
    tracker.record('a', undefined);
    now = Date.parse('2026-10-18T03:00:30Z'); // meia-noite em São Paulo
    expect(tracker.sizes()).toEqual({ users: 0, groups: 0 });
  });
});
