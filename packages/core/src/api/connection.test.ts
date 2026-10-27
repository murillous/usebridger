// M7-5 (ADR 0129): conexão pela API e tempo real por SSE.

import { afterEach, describe, expect, it } from 'vitest';
import { createAuthStore } from '#auth/store.ts';
import { type Bot, type BotConfig, createBot } from '#bot/bot.ts';
import { RecordingTransport, recordingLogger } from '#bot/harness.test-support.ts';
import { createHttp } from '#http/server.ts';
import { createSecretSet } from '#logger/secrets.ts';
import { definePlugin } from '#plugin/define.ts';
import type { PluginContext } from '#plugin/types.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { kernelStorage } from '#storage/namespace.ts';

class PairingTransport extends RecordingTransport {
  readonly phones: string[] = [];

  constructor() {
    super(['send.text', 'pairing']);
  }

  async requestPairingCode(phone: string): Promise<string> {
    this.phones.push(phone);
    this.emit('connection.pairing-code', { code: 'ABCD-1234' });
    return 'ABCD-1234';
  }

  async logout(): Promise<void> {
    this.calls.push('logout');
    this.emit('connection.status', { status: 'closed', reason: 'logged-out', error: null });
  }
}

interface Frame {
  readonly id: string;
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/** Stream SSE aberto: `until` lê até a condição valer sobre tudo o que chegou. */
interface Sse {
  readonly status: number;
  readonly frames: Frame[];
  until(done: (frames: Frame[]) => boolean): Promise<Frame[]>;
  close(): void;
}

const streams: Sse[] = [];
const bots: Bot[] = [];
afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close();
  for (const bot of bots.splice(0)) await bot.stop().catch(() => undefined);
});

async function openSse(url: string, headers: Record<string, string> = {}): Promise<Sse> {
  const abort = new AbortController();
  const res = await fetch(url, { headers, signal: abort.signal });
  const frames: Frame[] = [];
  const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  const read = async (): Promise<boolean> => {
    const chunk = await reader?.read();
    if (chunk === undefined || chunk.done) return false;
    buffer += chunk.value;
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const field = (name: string) =>
        block
          .split('\n')
          .find((line) => line.startsWith(`${name}: `))
          ?.slice(name.length + 2);
      const data = field('data');
      if (data !== undefined) {
        frames.push({ id: field('id') ?? '', event: field('event') ?? '', data: JSON.parse(data) });
      }
    }
    return true;
  };
  // A primeira linha (`retry:`) chega já assinado: o que o teste emitir depois entra no stream.
  if (res.ok) await read();
  const sse: Sse = {
    status: res.status,
    frames,
    async until(done) {
      const timeout = setTimeout(() => abort.abort(), 2000);
      try {
        while (!done(frames)) if (!(await read())) break;
      } finally {
        clearTimeout(timeout);
      }
      return frames;
    },
    close: () => abort.abort(),
  };
  streams.push(sse);
  return sse;
}

async function start<T extends RecordingTransport = PairingTransport>(
  config: Partial<Omit<BotConfig, 'transport'>> & { transport?: T } = {},
  setup: (ctx: PluginContext) => void = () => undefined,
) {
  // Sem `transport`, o padrão é o `PairingTransport`, e o `T` padrão diz isso ao tipo.
  const transport = (config.transport ?? new PairingTransport()) as T;
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const bot = createBot({
    logger: recordingLogger(),
    env: {},
    http,
    ...config,
    transport,
    plugins: [
      definePlugin({
        name: 'p',
        version: '1.0.0',
        engine: '>=0.0.0',
        setup(ctx) {
          // A porta só abre com rota de plugin ou transport (ADR 0072).
          ctx.http.route('GET', '/ping', () => new Response('pong'));
          setup(ctx);
        },
      }),
    ],
  });
  bots.push(bot);
  await bot.start();
  return { bot, transport, base: `http://127.0.0.1:${http.port}/api` };
}

const statusOf = (frames: Frame[], status: string) =>
  frames.some((f) => f.event === 'connection.status' && f.data['status'] === status);

describe('GET /connection', () => {
  it('estado, transport e conta conectada', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/connection`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'open',
      transport: 'test',
      pairing: true,
      account: { id: 'bot@test', name: 'Bot', phone: null },
      connectedSince: expect.any(Number),
      reconnections: 0,
    });
  });
});

describe('GET /events', () => {
  it('QR emitido chega no stream, com o estado atual antes dele', async () => {
    const { base, transport } = await start();
    const sse = await openSse(`${base}/events`);
    expect(sse.status).toBe(200);
    transport.emit('connection.status', { status: 'connecting' });
    transport.emit('connection.qr', { qr: 'QR-1', expiresAt: 123 });
    const frames = await sse.until((all) => all.some((f) => f.event === 'connection.qr'));
    expect(frames[0]).toMatchObject({ event: 'connection.status', data: { status: 'open' } });
    expect(frames.find((f) => f.event === 'connection.qr')?.data).toEqual({
      qr: 'QR-1',
      expiresAt: 123,
    });
  });

  it('quem chega sem Last-Event-ID recebe o QR que ainda vale', async () => {
    const { base, transport } = await start();
    transport.emit('connection.status', { status: 'connecting' });
    transport.emit('connection.qr', { qr: 'QR-1' });
    const sse = await openSse(`${base}/events?types=connection.status,connection.qr`);
    const frames = await sse.until((all) => all.length >= 2);
    expect(frames.map((f) => f.event)).toEqual(['connection.status', 'connection.qr']);
    // Depois do `open` o QR não vale mais e sai do estado inicial.
    transport.emit('connection.status', { status: 'open' });
    const late = await openSse(`${base}/events?types=connection.status,connection.qr`);
    expect((await late.until((all) => all.length >= 1)).map((f) => f.event)).toEqual([
      'connection.status',
    ]);
  });

  it('reconexão com Last-Event-ID não perde nem duplica', async () => {
    const { base, transport } = await start();
    const first = await openSse(`${base}/events?types=connection.qr`);
    transport.emit('connection.qr', { qr: 'QR-1' });
    const [seen] = await first.until((all) => all.length >= 1);
    first.close();
    // Enquanto o cliente está fora.
    transport.emit('connection.qr', { qr: 'QR-2' });
    transport.emit('connection.qr', { qr: 'QR-3' });
    const again = await openSse(`${base}/events?types=connection.qr`, {
      'last-event-id': seen?.id ?? '',
    });
    transport.emit('connection.qr', { qr: 'QR-4' });
    const frames = await again.until((all) => all.length >= 3);
    expect(frames.map((f) => f.data['qr'])).toEqual(['QR-2', 'QR-3', 'QR-4']);
    expect(new Set(frames.map((f) => f.id)).size).toBe(3);
  });

  it('filtra por tipo e recusa tipo desconhecido', async () => {
    const { base, transport } = await start({}, (ctx) => {
      ctx.events.on('connection.qr', () => ctx.log.info('viu o qr'));
    });
    const sse = await openSse(`${base}/events?types=log`);
    transport.emit('connection.qr', { qr: 'QR-1' });
    const frames = await sse.until((all) => all.some((f) => f.data['message'] === 'viu o qr'));
    expect(new Set(frames.map((f) => f.event))).toEqual(new Set(['log']));
    expect((await fetch(`${base}/events?types=log,nada`)).status).toBe(400);
  });

  it('log no stream sai com o segredo censurado', async () => {
    const secrets = createSecretSet();
    secrets.set('p', ['segredo-bem-comprido']);
    const { base } = await start({ secrets }, (ctx) => {
      ctx.http.route('POST', '/log', () => {
        ctx.log.warn('token segredo-bem-comprido vazou', { token: 'segredo-bem-comprido' });
        return new Response(null, { status: 204 });
      });
    });
    const sse = await openSse(`${base}/events?types=log`);
    await fetch(`${base.replace('/api', '')}/plugins/p/log`, { method: 'POST' });
    const frames = await sse.until((all) => all.some((f) => f.data['level'] === 'warn'));
    const line = frames.find((f) => f.data['level'] === 'warn');
    expect(line?.data['message']).toBe('token [REDACTED] vazou');
    expect(JSON.stringify(line)).not.toContain('segredo-bem-comprido');
  });

  it('disable e enable de plugin saem em plugin.status', async () => {
    const { base, bot } = await start();
    const sse = await openSse(`${base}/events?types=plugin.status`);
    await bot.plugins.disable('p');
    await bot.plugins.enable('p');
    const frames = await sse.until((all) => all.length >= 2);
    expect(frames.map((f) => f.data)).toEqual([
      { name: 'p', status: 'skipped', reason: 'disabled' },
      { name: 'p', status: 'loaded' },
    ]);
  });

  it('o stream fecha quando o bot para', async () => {
    const { base, bot } = await start();
    const sse = await openSse(`${base}/events`);
    await bot.stop();
    await sse.until(() => false);
    expect(sse.frames.length).toBeGreaterThanOrEqual(1);
  });
});

describe('permissões do stream', () => {
  async function withKey(permissions: string[]) {
    const storage = createMemoryStorage();
    const started = await start({ storage, api: { auth: {} } });
    const { secret } = await createAuthStore(kernelStorage(storage, 'auth')).createApiKey(
      { name: 'k', permissions },
      new Date(),
    );
    return { ...started, auth: { authorization: `Bearer ${secret}` } };
  }

  it('sem connection.manage não recebe QR, código nem o valor do QR no log', async () => {
    const { base, transport, auth } = await withKey(['connection.read', 'logs.read']);
    const sse = await openSse(`${base}/events`, auth);
    transport.emit('connection.status', { status: 'connecting' });
    transport.emit('connection.qr', { qr: 'QR-1' });
    transport.emit('connection.pairing-code', { code: 'C0D3' });
    // Sentinela visível: tudo o que veio antes dela já passou pelo filtro.
    transport.emit('connection.status', { status: 'open' });
    const frames = await sse.until((all) => statusOf(all.slice(1), 'open'));
    expect(frames.some((f) => f.event === 'connection.qr')).toBe(false);
    expect(frames.some((f) => f.event === 'connection.pairing-code')).toBe(false);
    expect(JSON.stringify(frames)).not.toContain('QR-1');
    expect(JSON.stringify(frames)).not.toContain('C0D3');
    // O aviso sem valor (`info`) continua visível a quem lê log; a linha com o valor, não.
    const events = frames.map((f) => (f.data['fields'] as { event?: string } | undefined)?.event);
    expect(events).toContain('connection.qr.received');
    expect(events).not.toContain('connection.qr.value');
    expect(events).not.toContain('connection.pairing-code.value');
  });

  it('com connection.manage recebe o QR; sem logs.read não recebe log', async () => {
    const { base, transport, auth } = await withKey(['connection.read', 'connection.manage']);
    const sse = await openSse(`${base}/events`, auth);
    transport.emit('connection.qr', { qr: 'QR-1' });
    const frames = await sse.until((all) => all.some((f) => f.event === 'connection.qr'));
    expect(frames.some((f) => f.event === 'log')).toBe(false);
  });

  it('sem connection.read o stream é 403; sem credencial, 401', async () => {
    const { base, auth } = await withKey(['logs.read']);
    expect((await fetch(`${base}/events`, { headers: auth })).status).toBe(403);
    expect((await fetch(`${base}/events`)).status).toBe(401);
  });

  it('pairing-code e logout exigem connection.manage', async () => {
    const { base, auth } = await withKey(['connection.read']);
    const post = (path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    expect((await post('/connection/pairing-code', { phone: '5511999999999' })).status).toBe(403);
    expect((await post('/connection/logout')).status).toBe(403);
  });
});

describe('pareamento e logout', () => {
  const post = (base: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  it('pede o código, devolve e publica no stream', async () => {
    const { base, transport } = await start();
    transport.emit('connection.status', { status: 'connecting' });
    const sse = await openSse(`${base}/events?types=connection.pairing-code`);
    const res = await post(base, '/connection/pairing-code', { phone: '5511999999999' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: 'ABCD-1234' });
    expect(transport.phones).toEqual(['5511999999999']);
    const frames = await sse.until((all) => all.length >= 1);
    expect(frames[0]?.data).toEqual({ code: 'ABCD-1234' });
  });

  it('recusa telefone inválido, sessão já conectada e transport sem pareamento', async () => {
    const { base, transport } = await start();
    expect((await post(base, '/connection/pairing-code', { phone: '+55 11' })).status).toBe(400);
    // Conectado (`open` do connect).
    expect((await post(base, '/connection/pairing-code', { phone: '5511999999999' })).status).toBe(
      409,
    );
    expect(transport.phones).toEqual([]);
    const plain = await start({ transport: new RecordingTransport() });
    expect(
      (await post(plain.base, '/connection/pairing-code', { phone: '5511999999999' })).status,
    ).toBe(409);
    expect((await post(plain.base, '/connection/logout')).status).toBe(409);
  });

  it('logout desvincula e o stream mostra o logged-out', async () => {
    const { base, transport } = await start({ reconnection: false });
    const sse = await openSse(`${base}/events?types=connection.status`);
    const res = await post(base, '/connection/logout');
    expect(res.status).toBe(200);
    expect(transport.calls).toContain('logout');
    const frames = await sse.until((all) => all.some((f) => f.data['reason'] === 'logged-out'));
    expect(frames.at(-1)?.data).toEqual({ status: 'closed', reason: 'logged-out' });
  });
});
