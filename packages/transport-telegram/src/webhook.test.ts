// Webhook do Telegram (#310): o transport registra a rota no HTTP do core e recebe os updates
// por ela, em vez do long polling. Usa o `createHttp` de verdade com o Telegram falso.

import {
  type Bot,
  type ConnectionStatus,
  command,
  createBot,
  createHttp,
  createLogger,
  createMemoryStorage,
  definePlugin,
  type HttpServer,
} from '@usebridger/core';
import type { Message as TgMessage } from 'grammy/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeTelegram, failure } from './fake-telegram.test-support.ts';
import { telegram } from './index.ts';
import { TelegramTransport, type TelegramWebhook } from './transport.ts';

const WEBHOOK: TelegramWebhook = { url: 'https://bot.exemplo.com/hook', secretToken: 'segredo-1' };
const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';
const USER = { id: 7, is_bot: false, first_name: 'Ana' };
const CHAT = { id: 7, type: 'private' as const, first_name: 'Ana' };

const ping = definePlugin({
  name: 'portatil',
  version: '1.0.0',
  engine: '>=0.0.0',
  setup(ctx) {
    ctx.commands.add(command({ name: 'ping', run: (c) => c.reply('pong') }));
  },
});

const bots: Bot[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop();
});

async function start(fake = new FakeTelegram()) {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const statuses: ConnectionStatus[] = [];
  const bot = createBot({
    transport: (deps) => {
      const transport = new TelegramTransport(fake.driver, deps, WEBHOOK);
      transport.on('connection.status', (status) => {
        statuses.push(status);
      });
      return transport;
    },
    http,
    storage: createMemoryStorage(),
    logger: createLogger({ level: 'silent' }),
    outbound: { globalIntervalMs: 0, chatIntervalMs: 0 },
    env: {},
    prefix: '/',
    plugins: [ping],
  });
  bots.push(bot);
  await bot.start();
  return { fake, http, bot, statuses };
}

function post(http: HttpServer, update: unknown, secret: string | null = WEBHOOK.secretToken) {
  return fetch(`http://127.0.0.1:${http.port}/transports/telegram/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret !== null && { [SECRET_HEADER]: secret }),
    },
    body: JSON.stringify(update),
  });
}

function text(id: number, body: string) {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1_760_000_000,
      chat: CHAT,
      from: USER,
      text: body,
    } as TgMessage,
  };
}

describe('webhook pelo HTTP do core', () => {
  it('registra o webhook com o segredo e os updates permitidos, sem long polling', async () => {
    const { fake, statuses } = await start();
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual({ status: 'open' }));
    const [call] = fake.callsTo('setWebhook');
    expect(fake.callsTo('setWebhook')).toHaveLength(1);
    expect(call).toMatchObject({ url: WEBHOOK.url, secret_token: WEBHOOK.secretToken });
    expect(call?.['allowed_updates']).toContain('callback_query');
    expect(fake.callsTo('getUpdates')).toEqual([]);
    expect(fake.callsTo('deleteWebhook')).toEqual([]);
  });

  it('o update que chega na rota com o segredo roda o comando', async () => {
    const { fake, http, statuses } = await start();
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual({ status: 'open' }));
    const response = await post(http, text(1, '/ping'));
    expect(response.status).toBe(200);
    await vi.waitFor(() =>
      expect(fake.callsTo('sendMessage').map((p) => p['text'])).toEqual(['pong']),
    );
  });

  it('recusa com 401 sem o segredo ou com segredo errado, e não processa o update', async () => {
    const { fake, http, statuses } = await start();
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual({ status: 'open' }));
    expect((await post(http, text(1, '/ping'), null)).status).toBe(401);
    expect((await post(http, text(2, '/ping'), 'outro')).status).toBe(401);
    expect(fake.callsTo('sendMessage')).toEqual([]);
  });

  it('o disconnect não apaga o webhook', async () => {
    const { fake, bot, statuses } = await start();
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual({ status: 'open' }));
    await bot.stop();
    expect(fake.callsTo('deleteWebhook')).toEqual([]);
  });

  it('401 no setWebhook vira auth-failed', async () => {
    const fake = new FakeTelegram();
    fake.handlers.set('setWebhook', () => failure(401, 'Unauthorized'));
    const { statuses } = await start(fake);
    await vi.waitFor(() =>
      expect(statuses).toContainEqual(
        expect.objectContaining({ status: 'closed', reason: 'auth-failed' }),
      ),
    );
  });

  it('401 no getMe vira auth-failed, sem chegar ao setWebhook', async () => {
    const fake = new FakeTelegram();
    fake.handlers.set('getMe', () => failure(401, 'Unauthorized'));
    const { statuses } = await start(fake);
    await vi.waitFor(() =>
      expect(statuses).toContainEqual(
        expect.objectContaining({ status: 'closed', reason: 'auth-failed' }),
      ),
    );
    expect(fake.callsTo('setWebhook')).toEqual([]);
  });
});

describe('fábrica com webhook', () => {
  const token = '123456:ABC-DEF';

  it('lança sem http no createBot', () => {
    const factory = telegram({ token, webhook: WEBHOOK });
    const deps = { session: 'default', log: createLogger({ level: 'silent' }) };
    expect(() => factory(deps as never)).toThrow(/http/);
  });

  it('valida a URL (https) e o segredo, sem pôr o segredo na mensagem', () => {
    expect(() => telegram({ token, webhook: { ...WEBHOOK, url: 'http://x.com/h' } })).toThrow(
      /https/,
    );
    expect(() => telegram({ token, webhook: { ...WEBHOOK, url: 'nada' } })).toThrow(/url/);
    expect(() => telegram({ token, webhook: { ...WEBHOOK, secretToken: '' } })).toThrow(
      /secretToken/,
    );
    const bad = { ...WEBHOOK, secretToken: 'com espaço' };
    expect(() => telegram({ token, webhook: bad })).toThrow(/secretToken/);
    expect(() => telegram({ token, webhook: bad })).not.toThrow(/com espaço/);
  });
});
