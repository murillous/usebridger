// Timer de 2 s do dashboard: reenvia o status por WS quando a fila de saída muda.

import { createHttp, definePlugin, type PluginContext } from '@usebridger/core';
import { createTestBot } from '@usebridger/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dashboard } from './index.ts';

const TOKEN = 'segredo-do-painel';

beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
afterEach(() => vi.useRealTimers());

describe('fila de saída ao vivo no WS', () => {
  it('manda status quando a fila muda, só no tick de 2 s, e para depois do stop', async () => {
    let captured: PluginContext | undefined;
    const sonda = definePlugin({
      name: 'sonda',
      version: '1.0.0',
      engine: '<1.0.0',
      setup(ctx) {
        captured = ctx;
      },
    });
    const http = createHttp({ port: 0, hostname: '127.0.0.1' });
    // Intervalo global longo: o que entra na fila fica pendente.
    const bot = await createTestBot({
      plugins: [dashboard, sonda],
      http,
      logLevel: 'info',
      pluginConfig: { dashboard: { token: TOKEN } },
      outbound: { globalIntervalMs: 600_000, chatIntervalMs: 600_000 },
    });
    const base = `http://127.0.0.1:${http.port}/plugins/dashboard`;
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      body: JSON.stringify({ token: TOKEN }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const messages: Record<string, unknown>[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${http.port}/plugins/dashboard/api/ws`, {
      headers: { cookie },
    } as never);
    socket.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data))));
    await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(1));
    const before = messages.length;

    // Três envios para o mesmo chat: o primeiro sai, os outros ficam pendentes.
    for (const n of [1, 2, 3]) {
      void captured?.send.send('chat@fake', `m${n}`).catch(() => undefined);
    }
    await vi.waitFor(() => {
      const { high, normal, low } = captured?.stats().outbound.pending ?? {
        high: 0,
        normal: 0,
        low: 0,
      };
      expect(high + normal + low).toBeGreaterThan(0);
    });
    expect(messages).toHaveLength(before); // nada sai antes do tick

    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(before));
    const last = messages.at(-1);
    expect(last?.['type']).toBe('status');
    expect(last?.['outboundPending']).toBeGreaterThan(0);

    const count = messages.length;
    await vi.advanceTimersByTimeAsync(2000); // número igual: não reenvia
    expect(messages).toHaveLength(count);

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    socket.close();
    void bot.stop();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(messages).toHaveLength(count);
  });
});
