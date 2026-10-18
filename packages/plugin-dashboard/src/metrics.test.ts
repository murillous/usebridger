import { createHttp, definePlugin, type PluginDefinition } from '@usebridger/core';
import { type MetricsService, metrics } from '@usebridger/plugin-metrics';
import { createTestBot } from '@usebridger/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { dashboard } from './index.ts';
import type { MetricsView } from './metrics.ts';

const TOKEN = 'segredo-do-painel';
const bots: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop();
});

// Plugin de terceiros: registra métricas que o dashboard não conhece de antemão.
const lembretes = definePlugin({
  name: 'lembretes',
  version: '1.0.0',
  engine: '<1.0.0',
  dependsOn: { metrics: '*' },
  setup(ctx) {
    const m = ctx.services.get('metrics');
    m.counter('lembretes.enviados', { canal: 'email' }, 3);
    m.observe('lembretes.atraso_ms', { canal: 'email' }, 40);
  },
});

// Simula um plugin-metrics anterior ao `names`.
const antigo = definePlugin({
  name: 'metrics',
  version: '0.0.1',
  engine: '<1.0.0',
  setup(ctx) {
    const old = { counter: () => undefined, observe: () => undefined, query: async () => [] };
    ctx.services.provide('metrics', old as unknown as MetricsService);
  },
});

async function start(plugins: PluginDefinition[]) {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const bot = await createTestBot({
    plugins: [dashboard, ...plugins],
    http,
    logLevel: 'info',
    pluginConfig: { dashboard: { token: TOKEN } },
  });
  bots.push(bot);
  const url = `http://127.0.0.1:${http.port}/plugins/dashboard`;
  const login = await fetch(`${url}/api/login`, {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return { url, get: (path: string) => fetch(`${url}${path}`, { headers: { cookie } }) };
}

describe('GET /api/metrics', () => {
  it('exige sessão', async () => {
    const { url } = await start([metrics]);
    expect((await fetch(`${url}/api/metrics`)).status).toBe(401);
  });

  it('sem o plugin de métricas o dashboard sobe e responde available: false', async () => {
    const { get } = await start([]);
    const res = await get('/api/metrics');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
    expect((await get('/api/status')).status).toBe(200);
  });

  it('lista métrica registrada por qualquer plugin, sem o dashboard conhecê-la', async () => {
    const { get } = await start([metrics, lembretes]);
    const body = (await (await get('/api/metrics?days=1')).json()) as MetricsView & {
      available: boolean;
    };
    expect(body.available).toBe(true);
    const byName = Object.fromEntries(body.metrics.map((m) => [m.name, m.rows]));
    expect(Object.keys(byName)).toEqual(
      expect.arrayContaining(['lembretes.enviados', 'lembretes.atraso_ms']),
    );
    expect(byName['lembretes.enviados']).toMatchObject([{ type: 'counter', value: 3 }]);
    expect(byName['lembretes.atraso_ms']).toMatchObject([{ type: 'histogram', count: 1 }]);
  });

  it('devolve o plugin dono de cada métrica declarada', async () => {
    const dono = definePlugin({
      name: 'dono',
      version: '1.0.0',
      engine: '<1.0.0',
      dependsOn: { metrics: '*' },
      setup(ctx) {
        const m = ctx.services.get('metrics');
        m.counter('dono.x', {});
        m.declareOwner('dono.x', 'dono');
        m.counter('sem.dono', {});
      },
    });
    const { get } = await start([metrics, dono]);
    const body = (await (await get('/api/metrics?days=1')).json()) as MetricsView;
    const plugin = Object.fromEntries(body.metrics.map((m) => [m.name, m.plugin]));
    expect(plugin['dono.x']).toBe('dono');
    expect(plugin['sem.dono']).toBeUndefined();
  });

  it('plugin-metrics sem names responde available: false com reason version, não 500', async () => {
    const { get } = await start([antigo]);
    const res = await get('/api/metrics');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, reason: 'version' });
  });

  it('days inválido dá 400', async () => {
    const { get } = await start([metrics]);
    for (const days of ['0', '91', 'x', '1.5']) {
      expect((await get(`/api/metrics?days=${days}`)).status).toBe(400);
    }
  });
});
