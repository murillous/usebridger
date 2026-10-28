// Métricas pela API do core (ADR 0135): `catalog` e `query` iguais aos do serviço, 400 no intervalo
// inválido e 403 sem `metrics.read`.

import { createHttp, definePlugin } from '@usebridger/core';
import { createTestBot, type TestBot } from '@usebridger/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { type MetricsService, metrics } from './index.ts';

const BOOTSTRAP = 'token-de-bootstrap-do-teste';

const bots: TestBot[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop();
});

async function boot(auth = false) {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  let service: MetricsService | undefined;
  const consumer = definePlugin({
    name: 'consumidor',
    version: '1.0.0',
    engine: '<1.0.0',
    dependsOn: { metrics: '*' },
    setup(ctx) {
      service = ctx.services.get('metrics');
    },
  });
  const bot = await createTestBot({
    plugins: [metrics, consumer],
    http,
    ...(auth && { api: { auth: { bootstrapToken: BOOTSTRAP } } }),
  });
  bots.push(bot);
  const base = `http://127.0.0.1:${http.port}/api`;
  return { base, service: service as MetricsService };
}

/** Primeiro owner pelo bootstrap; devolve quem cria API keys com a sessão dele. */
async function owner(base: string) {
  const json = { 'content-type': 'application/json' };
  const accepted = await fetch(`${base}/auth/invites/accept`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      token: BOOTSTRAP,
      name: 'Dona',
      email: 'dona@exemplo.com',
      password: 'uma senha bem longa',
    }),
  });
  expect(accepted.status).toBe(200);
  const cookie = (accepted.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return async (permissions: string[]): Promise<Record<string, string>> => {
    const created = await fetch(`${base}/keys`, {
      method: 'POST',
      headers: { ...json, cookie },
      body: JSON.stringify({ name: 'k', permissions }),
    });
    expect(created.status).toBe(201);
    const { secret } = (await created.json()) as { secret: string };
    return { authorization: `Bearer ${secret}` };
  };
}

describe('GET /api/plugins/metrics/query', () => {
  it('responde o mesmo que o query do serviço, com o +Inf do histograma em texto', async () => {
    const { base, service } = await boot();
    service
      .counter({ name: 'p_cliques_total', help: 'h', labelNames: ['botao'] })
      .inc({ botao: 'a' }, 2);
    service
      .counter({ name: 'p_cliques_total', help: 'h', labelNames: ['botao'] })
      .inc({ botao: 'b' });
    service
      .histogram({ name: 'p_espera_seconds', help: 'h', labelNames: [], buckets: [0.1, 1] })
      .observe({}, 0.5);
    const today = new Date().toISOString().slice(0, 10);

    const counter = await fetch(
      `${base}/plugins/metrics/query?name=p_cliques_total&from=${today}&to=${today}&where=botao:a`,
    );
    expect(counter.status).toBe(200);
    expect(await counter.json()).toEqual({
      rows: await service.query({
        name: 'p_cliques_total',
        from: today,
        to: today,
        granularity: 'day',
        where: { botao: 'a' },
      }),
    });

    const total = await fetch(
      `${base}/plugins/metrics/query?name=p_cliques_total&from=${today}&to=${today}&groupBy=`,
    );
    expect(((await total.json()) as { rows: { value: number }[] }).rows).toEqual([
      expect.objectContaining({ value: 3, labels: {} }),
    ]);

    const hour = new Date().toISOString().slice(0, 13);
    const histogram = await fetch(
      `${base}/plugins/metrics/query?name=p_espera_seconds&from=${hour}&to=${hour}&granularity=hour`,
    );
    const expected = (
      await service.query({ name: 'p_espera_seconds', from: hour, to: hour, granularity: 'hour' })
    ).map((row) =>
      row.type === 'histogram'
        ? {
            ...row,
            buckets: row.buckets.map((b) => ({ ...b, le: Number.isFinite(b.le) ? b.le : '+Inf' })),
          }
        : row,
    );
    const body = (await histogram.json()) as { rows: unknown[] };
    expect(body.rows).toEqual(expected);
    expect(JSON.stringify(body)).toContain('"le":"+Inf"');
  });

  it('intervalo inválido e where malformado são 400 problem+json', async () => {
    const { base } = await boot();
    const bad = await fetch(`${base}/plugins/metrics/query?name=x&from=2026-02-02&to=2026-01-01`);
    expect(bad.status).toBe(400);
    expect(bad.headers.get('content-type')).toContain('application/problem+json');
    expect(((await bad.json()) as { detail: string }).detail).toContain('depois de to');
    const where = await fetch(
      `${base}/plugins/metrics/query?name=x&from=2026-01-01&to=2026-01-01&where=semdoispontos`,
    );
    expect(where.status).toBe(400);
  });
});

describe('GET /api/plugins/metrics/catalog', () => {
  it('responde o catalog() do serviço', async () => {
    const { base, service } = await boot();
    service.gauge({ name: 'p_fila', help: 'Fila', labelNames: [] }).set({}, 1);
    const res = await fetch(`${base}/plugins/metrics/catalog`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ metrics: await service.catalog() });
  });
});

describe('permissão', () => {
  it('sem metrics.read é 403; com ela, 200', async () => {
    const { base } = await boot(true);
    const keyWith = await owner(base);
    const denied = await keyWith(['logs.read']);
    expect((await fetch(`${base}/plugins/metrics/catalog`, { headers: denied })).status).toBe(403);
    const allowed = await keyWith(['metrics.read']);
    expect((await fetch(`${base}/plugins/metrics/catalog`, { headers: allowed })).status).toBe(200);
  });
});
