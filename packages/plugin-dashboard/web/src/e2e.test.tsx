// @vitest-environment happy-dom
// Ponta a ponta mínimo (M7-10): o app no happy-dom contra um bot de verdade, com a auth da API,
// o transport falso e o `fetch` do happy-dom (cookie de sessão real, mesma origem).

import { cleanup, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import {
  type Bot,
  createBot,
  createHttp,
  createMemoryStorage,
  definePlugin,
  type Logger,
} from '@usebridger/core';
import { z } from '@usebridger/core/zod';
import { FakeTransport } from '@usebridger/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { renderApp } from './test-support.tsx';

const BOOTSTRAP = 'token-de-bootstrap-do-e2e';

/**
 * O happy-dom não tem `EventSource`: este lê o `GET /events` pelo `fetch` dele, com o mesmo
 * cookie, e entrega os eventos como o do browser.
 */
class FetchEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly #abort = new AbortController();
  readonly #listeners = new Map<string, ((event: { data: string }) => void)[]>();
  constructor(url: string) {
    this.#read(url).catch(() => this.onerror?.());
  }
  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.#abort.abort();
  }
  async #read(url: string): Promise<void> {
    const response = await fetch(url, { credentials: 'same-origin', signal: this.#abort.signal });
    if (!response.ok || response.body === null) throw new Error(`events: ${response.status}`);
    this.onopen?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf('\n\n');
      while (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const field = (name: string) =>
          block
            .split('\n')
            .find((line) => line.startsWith(`${name}: `))
            ?.slice(name.length + 2);
        const type = field('event');
        const data = field('data');
        if (type !== undefined && data !== undefined) {
          for (const listener of this.#listeners.get(type) ?? []) listener({ data });
        }
        end = buffer.indexOf('\n\n');
      }
    }
  }
}

let bot: Bot;
let transport: FakeTransport;
let log: Logger;
let greeting: string | undefined;

beforeAll(async () => {
  transport = new FakeTransport();
  const http = createHttp({ port: 0, hostname: 'localhost' });
  bot = createBot({
    transport,
    http,
    storage: createMemoryStorage(),
    env: {},
    logLevel: 'info',
    reconnection: false,
    api: { auth: { bootstrapToken: BOOTSTRAP } },
    plugins: [
      definePlugin({
        name: 'demo',
        version: '1.0.0',
        engine: '<1.0.0',
        config: z.object({ greeting: z.string().default('oi').meta({ title: 'Saudação' }) }),
        setup(ctx) {
          // A porta só abre com alguma rota de plugin; o app vem do Vite, não do plugin.
          ctx.http.route('GET', '/ping', () => new Response('pong'));
          log = ctx.log;
          greeting = ctx.config.greeting;
        },
      }),
    ],
  });
  await bot.start();
  // O app roda como se servido pelo plugin: mesma origem da API, `<base href>` do plugin.
  const page = `http://localhost:${http.port}/plugins/dashboard/`;
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(page);
  const base = document.createElement('base');
  base.href = page;
  document.head.append(base);
  vi.stubGlobal('EventSource', FetchEventSource);
});

afterAll(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await bot?.stop();
});

it('primeiro acesso, login, QR ao vivo, log ao vivo e editar a config', async () => {
  renderApp();

  // Primeiro acesso: o token de bootstrap vale como convite do owner.
  await userEvent.click(await screen.findByRole('link', { name: 'Tenho um convite' }));
  await userEvent.type(await screen.findByLabelText('Token do convite'), BOOTSTRAP);
  await userEvent.click(screen.getByLabelText('Primeiro acesso (token de bootstrap)'));
  await userEvent.type(screen.getByLabelText('Nome'), 'Dona');
  await userEvent.type(screen.getByLabelText('E-mail'), 'dona@exemplo.com');
  await userEvent.type(screen.getByLabelText('Senha nova'), 'uma senha bem longa');
  await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
  await screen.findByRole('heading', { name: 'Conexão' });

  // Sair e entrar de novo pelo login.
  await userEvent.click(screen.getByRole('button', { name: 'Sair' }));
  await userEvent.type(await screen.findByLabelText('E-mail'), 'dona@exemplo.com');
  await userEvent.type(screen.getByLabelText('Senha'), 'uma senha bem longa');
  await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
  await screen.findByRole('heading', { name: 'Conexão' });
  await screen.findByText('ao vivo');

  // QR ao vivo: o transport pede pareamento e o QR chega pelo stream.
  transport.emit('connection.status', { status: 'connecting' });
  transport.emit('connection.qr', { qr: 'qr-do-e2e' });
  expect(await screen.findByAltText('QR de pareamento', {}, { timeout: 3000 })).toBeTruthy();

  // Log ao vivo.
  window.location.hash = '#/logs';
  await screen.findByRole('heading', { name: 'Logs' });
  log.info('linha do e2e');
  expect(await screen.findByText(/linha do e2e/, {}, { timeout: 3000 })).toBeTruthy();

  // Editar a config: o plugin recarrega com o valor novo.
  window.location.hash = '#/plugins/demo';
  const field = await screen.findByLabelText('Saudação');
  await userEvent.clear(field);
  await userEvent.type(field, 'olá');
  await userEvent.click(screen.getByRole('button', { name: 'Salvar e recarregar' }));
  await screen.findByText('Config salva; o plugin recarregou.');
  await waitFor(() => expect(greeting).toBe('olá'));
}, 20_000);
