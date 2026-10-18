import { CORE_VERSION, createHttp, definePlugin, type Logger } from '@usebridger/core';
import { createTestBot, FakeTransport } from '@usebridger/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessions } from './auth.ts';
import { dashboard, type StatusView } from './index.ts';
import { createLogBuffer } from './logs.ts';

const TOKEN = 'segredo-do-painel';
const bots: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop();
});

// Plugin que expõe o logger do bot, para os testes gerarem linhas de log.
let botLog: Logger;
const logger = definePlugin({
  name: 'logger',
  version: '1.0.0',
  engine: '<1.0.0',
  setup(ctx) {
    botLog = ctx.log;
  },
});

async function start(config: Record<string, unknown> = {}) {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const bot = await createTestBot({
    plugins: [dashboard, logger],
    http,
    logLevel: 'info',
    pluginConfig: { dashboard: { token: TOKEN, ...config } },
  });
  bots.push(bot);
  const host = `127.0.0.1:${http.port}`;
  const base = `http://${host}/plugins/dashboard`;
  const login = (token: string) =>
    fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ token }) });
  const cookie = async (): Promise<string> => {
    const res = await login(TOKEN);
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  };
  return { bot, host, base, login, cookie };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

function connect(url: string, headers: Record<string, string>) {
  // WebSocket do Node (undici) aceita headers no segundo argumento.
  const socket = new WebSocket(url, { headers } as never);
  const messages: Record<string, unknown>[] = [];
  socket.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data))));
  const opened = new Promise<boolean>((resolve) => {
    socket.addEventListener('open', () => resolve(true));
    socket.addEventListener('error', () => resolve(false));
  });
  return { socket, messages, opened };
}

describe('autenticação', () => {
  it('login certo dá 204 e cookie HttpOnly/SameSite/Path, sem o token da config', async () => {
    const { login } = await start();
    const res = await login(TOKEN);
    const set = res.headers.get('set-cookie') ?? '';
    expect(res.status).toBe(204);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
    expect(set).toContain('Path=/plugins/dashboard');
    expect(set).not.toContain(TOKEN);
    expect(set).not.toContain('Secure');
  });

  it('Secure quando o pedido veio por https (proxy)', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(res.headers.get('set-cookie')).toContain('Secure');
  });

  it('login errado ou sem token dá 401; corpo inválido dá 400', async () => {
    const { login, base } = await start();
    expect((await login('errado')).status).toBe(401);
    const vazio = await fetch(`${base}/api/login`, { method: 'POST', body: '{}' });
    expect(vazio.status).toBe(401);
    const lixo = await fetch(`${base}/api/login`, { method: 'POST', body: 'x' });
    expect(lixo.status).toBe(400);
  });

  it('rotas sem cookie ou com cookie inválido dão 401', async () => {
    const { base } = await start();
    for (const path of ['/api/status', '/api/logs']) {
      expect((await fetch(base + path)).status).toBe(401);
      const forged = await fetch(base + path, { headers: { cookie: 'bridger_dashboard=falso' } });
      expect(forged.status).toBe(401);
    }
  });

  it('logout invalida a sessão', async () => {
    const { base, cookie } = await start();
    const c = await cookie();
    expect((await fetch(`${base}/api/status`, { headers: { cookie: c } })).status).toBe(200);
    const out = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie: c } });
    expect(out.status).toBe(204);
    expect((await fetch(`${base}/api/status`, { headers: { cookie: c } })).status).toBe(401);
  });

  it('status traz as versões do core e do dashboard', async () => {
    const { base, cookie } = await start();
    const res = await fetch(`${base}/api/status`, { headers: { cookie: await cookie() } });
    const { versions } = (await res.json()) as StatusView;
    expect(versions).toEqual({ core: CORE_VERSION, dashboard: dashboard.version });
  });

  it('sessão expira', () => {
    let now = 0;
    const sessions = createSessions(10, () => now);
    const id = sessions.create();
    const req = new Request('http://x', { headers: { cookie: `bridger_dashboard=${id}` } });
    expect(sessions.valid(req)).toBe(true);
    now = 10_000;
    expect(sessions.valid(req)).toBe(false);
  });
});

describe('endurecimento', () => {
  it('login com corpo acima de 1 KiB dá 413, com e sem content-length', async () => {
    const { base } = await start();
    const big = JSON.stringify({ token: 'x'.repeat(2000) });
    const res = await fetch(`${base}/api/login`, { method: 'POST', body: big });
    expect(res.status).toBe(413);
    // Corpo em stream não leva content-length.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const chunked = await fetch(`${base}/api/login`, {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(chunked.status).toBe(413);
  });

  it('logout devolve o cookie expirado', async () => {
    const { base, cookie } = await start();
    const out = await fetch(`${base}/api/logout`, {
      method: 'POST',
      headers: { cookie: await cookie() },
    });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('token curto (< 16) é recusado na config', async () => {
    await expect(start({ token: 'curto' })).rejects.toThrow();
  });

  it('reload do plugin limpa as sessões: cookie antigo dá 401', async () => {
    const { bot, base, cookie } = await start();
    const c = await cookie();
    expect((await fetch(`${base}/api/status`, { headers: { cookie: c } })).status).toBe(200);
    await bot.bot.plugins.reload('dashboard');
    expect((await fetch(`${base}/api/status`, { headers: { cookie: c } })).status).toBe(401);
  });

  it('linha de log com bigint (o core a converte) não envenena /api/logs nem o snapshot do WS', async () => {
    const { host, base, cookie } = await start();
    const c = await cookie();
    botLog.info('com bigint', { n: 10n });
    const res = await fetch(`${base}/api/logs`, { headers: { cookie: c } });
    expect(res.status).toBe(200);
    const logs = (await res.json()) as { message: string; fields: unknown }[];
    expect(logs.find((l) => l.message === 'com bigint')?.fields).toMatchObject({ n: '10' });
    const ws = connect(`ws://${host}/plugins/dashboard/api/ws`, { cookie: c });
    expect(await ws.opened).toBe(true);
    await until(() => ws.messages.length >= 1);
    expect(ws.messages[0]?.['type']).toBe('snapshot');
    ws.socket.close();
  });

  it('toJSON que lança cai no fallback unserializable, sem quebrar /api/logs nem o WS', async () => {
    const { host, base, cookie } = await start();
    const c = await cookie();
    botLog.info('toJSON quebrado', {
      ruim: {
        toJSON() {
          throw new Error('x');
        },
      },
    });
    const res = await fetch(`${base}/api/logs`, { headers: { cookie: c } });
    expect(res.status).toBe(200);
    const logs = (await res.json()) as { message: string; fields: unknown }[];
    expect(logs.find((l) => l.message === 'toJSON quebrado')?.fields).toEqual({
      unserializable: true,
    });
    const ws = connect(`ws://${host}/plugins/dashboard/api/ws`, { cookie: c });
    expect(await ws.opened).toBe(true);
    await until(() => ws.messages.length >= 1);
    expect(ws.messages[0]?.['type']).toBe('snapshot');
    ws.socket.close();
  });

  it('WS sem Origin e com cookie válido é aceito', async () => {
    const { host, cookie } = await start();
    const ws = connect(`ws://${host}/plugins/dashboard/api/ws`, { cookie: await cookie() });
    expect(await ws.opened).toBe(true);
    ws.socket.close();
  });
});

describe('estado', () => {
  it('status informa se o transport pareia (capability pairing)', async () => {
    const { base, cookie } = await start();
    const res = await fetch(`${base}/api/status`, { headers: { cookie: await cookie() } });
    // O FakeTransport padrão tem todas as capabilities.
    expect(((await res.json()) as StatusView).pairing).toBe(true);
  });

  it('pairing é false quando o transport não tem a capability', async () => {
    const http = createHttp({ port: 0, hostname: '127.0.0.1' });
    bots.push(
      await createTestBot({
        plugins: [dashboard],
        http,
        transport: new FakeTransport({ capabilities: [] }),
        pluginConfig: { dashboard: { token: TOKEN } },
      }),
    );
    const base = `http://127.0.0.1:${http.port}/plugins/dashboard`;
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      body: JSON.stringify({ token: TOKEN }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const res = await fetch(`${base}/api/status`, { headers: { cookie } });
    expect(((await res.json()) as StatusView).pairing).toBe(false);
  });

  it('status reflete a conexão; QR e código saem no open; closed expõe só reason e mensagem', async () => {
    const { bot, base, cookie } = await start();
    const headers = { cookie: await cookie() };
    const get = async (): Promise<StatusView> =>
      (await (await fetch(`${base}/api/status`, { headers })).json()) as StatusView;

    await bot.emit('connection.qr', { qr: 'QR1' });
    await bot.emit('connection.pairing-code', { code: 'ABCD-1234' });
    expect(await get()).toMatchObject({
      transport: expect.any(String),
      qr: 'QR1',
      pairingCode: 'ABCD-1234',
    });

    await bot.emit('connection.status', { status: 'open' });
    const open = await get();
    expect(open.status).toBe('open');
    expect(open.qr).toBeUndefined();
    expect(open.pairingCode).toBeUndefined();

    await bot.emit('connection.status', {
      status: 'closed',
      reason: 'connection-lost',
      error: Object.assign(new Error('caiu'), { socket: { secret: 1 } }),
    });
    const closed = await get();
    expect(closed).toMatchObject({ status: 'closed', reason: 'connection-lost', message: 'caiu' });
    expect(JSON.stringify(closed)).not.toContain('socket');
  });

  it('status traz a sessão do bot', async () => {
    const { base, cookie } = await start();
    const res = await fetch(`${base}/api/status`, { headers: { cookie: await cookie() } });
    expect(((await res.json()) as StatusView).session).toBe('default');
  });

  it('depois de um reload o status reflete a conexão atual, sem evento novo', async () => {
    const { bot, base, cookie } = await start();
    await bot.emit('connection.status', {
      status: 'closed',
      reason: 'connection-lost',
      error: Object.assign(new Error('caiu'), { socket: { secret: 1 } }),
    });
    await bot.bot.plugins.reload('dashboard');
    const res = await fetch(`${base}/api/status`, { headers: { cookie: await cookie() } });
    const body = await res.json();
    expect(body).toMatchObject({
      status: 'closed',
      reason: 'connection-lost',
      message: 'caiu',
    });
    expect(JSON.stringify(body)).not.toContain('socket');
  });

  it('buffer de logs corta no tamanho', () => {
    const buffer = createLogBuffer(3);
    for (let i = 1; i <= 5; i++) {
      buffer.push({ level: 'info', time: i, message: `m${i}`, fields: {} });
    }
    expect(buffer.list().map((e) => e.message)).toEqual(['m3', 'm4', 'm5']);
  });

  it('GET /api/logs devolve as linhas do bot, limitadas por logBufferSize', async () => {
    const { base, cookie } = await start({ logBufferSize: 2 });
    const headers = { cookie: await cookie() };
    for (const n of [1, 2, 3]) botLog.info(`linha ${n}`);
    const logs = (await (await fetch(`${base}/api/logs`, { headers })).json()) as {
      message: string;
    }[];
    expect(logs.map((l) => l.message)).toEqual(['linha 2', 'linha 3']);
  });

  it('GET /api/logs?level= devolve só linhas de nível igual ou acima; inválido dá 400', async () => {
    const { base, cookie } = await start();
    const c = await cookie();
    botLog.info('nivel-info');
    botLog.warn('nivel-warn');
    botLog.error('nivel-error');
    botLog.fatal('nivel-fatal');
    const get = (q: string) => fetch(`${base}/api/logs${q}`, { headers: { cookie: c } });
    const msgs = async (q: string) =>
      ((await (await get(q)).json()) as { level: string; message: string }[])
        .filter((l) => l.message.startsWith('nivel-'))
        .map((l) => l.level);
    expect(await msgs('?level=warn')).toEqual(['warn', 'error', 'fatal']);
    expect(await msgs('')).toEqual(['info', 'warn', 'error', 'fatal']);
    expect((await get('?level=barulho')).status).toBe(400);
    expect((await get('?level=silent')).status).toBe(400);
    expect((await fetch(`${base}/api/logs?level=warn`)).status).toBe(401);
  });
});

describe('WebSocket', () => {
  it('o snapshot traz a sessão do bot', async () => {
    const { host, cookie } = await start();
    const ws = connect(`ws://${host}/plugins/dashboard/api/ws`, { cookie: await cookie() });
    expect(await ws.opened).toBe(true);
    await until(() => ws.messages.length > 0);
    expect(ws.messages[0]).toMatchObject({ type: 'snapshot', status: { session: 'default' } });
    ws.socket.close();
  });

  it('recusa sem cookie e com Origin de outro host', async () => {
    const { host, cookie } = await start();
    const url = `ws://${host}/plugins/dashboard/api/ws`;
    expect(await connect(url, {}).opened).toBe(false);
    const c = await cookie();
    expect(await connect(url, { cookie: c, origin: 'http://evil.example' }).opened).toBe(false);
  });

  it('manda snapshot e empurra status e log', async () => {
    const { bot, host, cookie } = await start();
    const c = await cookie();
    const ws = connect(`ws://${host}/plugins/dashboard/api/ws`, {
      cookie: c,
      origin: `http://${host}`,
    });
    expect(await ws.opened).toBe(true);
    await until(() => ws.messages.length >= 1);
    expect(ws.messages[0]).toMatchObject({ type: 'snapshot', status: { status: 'open' } });
    expect(Array.isArray(ws.messages[0]?.['logs'])).toBe(true);

    await bot.emit('connection.status', { status: 'connecting' });
    await until(() =>
      ws.messages.some((m) => m['type'] === 'status' && m['status'] === 'connecting'),
    );
    await bot.emit('connection.qr', { qr: 'Q' });
    await until(() => ws.messages.some((m) => m['type'] === 'qr' && m['qr'] === 'Q'));
    botLog.warn('olá painel');
    await until(() => ws.messages.some((m) => m['type'] === 'log'));
    ws.socket.close();
  });
});
