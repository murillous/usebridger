// M7-5 (ADR 0129): o `FakeTransport` atende ao pareamento por código e ao logout da API.

import { type Bot, createBot, createHttp, definePlugin } from '@usebridger/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeTransport } from './fake-transport.ts';

const bots: Bot[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop();
});

async function start(transport: FakeTransport) {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const bot = createBot({
    transport,
    http,
    env: {},
    logLevel: 'silent',
    reconnection: false,
    plugins: [
      definePlugin({
        name: 'p',
        version: '1.0.0',
        engine: '>=0.0.0',
        // A porta só abre com alguma rota de plugin.
        setup: (ctx) => ctx.http.route('GET', '/ping', () => new Response('pong')),
      }),
    ],
  });
  bots.push(bot);
  await bot.start();
  const base = `http://127.0.0.1:${http.port}/api`;
  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  return { base, post };
}

describe('FakeTransport na API de conexão', () => {
  it('pareia por código enquanto conecta', async () => {
    const transport = new FakeTransport();
    const codes: string[] = [];
    transport.on('connection.pairing-code', ({ code }) => {
      codes.push(code);
    });
    const { post } = await start(transport);
    transport.emit('connection.status', { status: 'connecting' });
    const res = await post('/connection/pairing-code', { phone: '5511999991234' });
    expect(await res.json()).toEqual({ code: 'FAKE-1234' });
    expect(transport.pairingRequests).toEqual(['5511999991234']);
    expect(codes).toEqual(['FAKE-1234']);
  });

  it('logout desvincula a sessão e o estado vira closed/logged-out', async () => {
    const transport = new FakeTransport();
    const { base, post } = await start(transport);
    const before = (await (await fetch(`${base}/connection`)).json()) as { account: unknown };
    expect(before.account).toMatchObject({
      id: transport.self?.id,
    });
    expect((await post('/connection/logout')).status).toBe(200);
    expect(transport.logouts).toBe(1);
    expect(await (await fetch(`${base}/connection`)).json()).toMatchObject({
      status: 'closed',
      reason: 'logged-out',
      account: null,
    });
  });

  it('sem a capability pairing as duas rotas respondem 409', async () => {
    const { post } = await start(new FakeTransport({ capabilities: ['send.text'] }));
    expect((await post('/connection/pairing-code', { phone: '5511999991234' })).status).toBe(409);
    expect((await post('/connection/logout')).status).toBe(409);
  });
});
