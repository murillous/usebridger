// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocketLike } from '#web/lib/live.ts';
import type { LiveMessage, StatusView, TabView } from '#web/lib/types.ts';
import { App } from './App.tsx';

// `api` chama `fetch('api/<caminho>')`: cada teste responde por "<MÉTODO> <caminho>".
type Reply = { status?: number; body?: unknown };
let routes: Record<string, () => Reply>;
const calls: string[] = [];
let sockets: FakeSocket[];

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
  }
  send(message: LiveMessage) {
    act(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }
  open() {
    act(() => this.onopen?.());
  }
}

const STATUS: StatusView = {
  transport: 'whatsapp',
  name: 'Luma',
  session: 'principal',
  status: 'open',
  updatedAt: 1_700_000_000_000,
  versions: { core: '1.2.3', dashboard: '4.5.6' },
};
const TAB: TabView = {
  key: 'reminders/lembretes',
  plugin: 'reminders',
  id: 'lembretes',
  title: 'Lembretes',
  order: 0,
  widgets: [],
};

beforeEach(() => {
  routes = { 'GET status': () => ({ body: STATUS }), 'GET tabs': () => ({ body: [TAB] }) };
  calls.length = 0;
  sockets = [];
  localStorage.clear();
  window.location.hash = '';
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.replace(/^api\//, '')}`;
    calls.push(key);
    const reply = routes[key]?.() ?? { status: 404, body: 'sem rota' };
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? '');
    return new Response(reply.status === 204 ? null : text, { status: reply.status ?? 200 });
  });
  // `function` (não arrow) para poder ser chamada com `new`; devolver o objeto faz o `new` entregá-lo.
  vi.stubGlobal('WebSocket', function WebSocketFake() {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = '';
  document.documentElement.removeAttribute('data-theme');
});

const goto = (hash: string) =>
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new Event('hashchange'));
  });
const side = () => screen.getAllByRole('navigation', { name: 'Principal' })[0] as HTMLElement;
const tabbar = () => screen.getAllByRole('navigation', { name: 'Principal' })[1] as HTMLElement;
const current = (nav: HTMLElement) =>
  within(nav)
    .getAllByRole('link')
    .find((a) => a.getAttribute('aria-current') === 'page')?.textContent;
const boot = async () => {
  render(<App />);
  await screen.findAllByRole('navigation', { name: 'Principal' });
};

describe('App: portão de login', () => {
  it('sem sessão (401 em status) mostra só o login', async () => {
    routes['GET status'] = () => ({ status: 401, body: 'unauthorized' });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Entrar no dashboard' })).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(sockets).toHaveLength(0);
  });

  it('entrar volta à rota em que estava', async () => {
    window.location.hash = '#/plugins';
    routes['GET status'] = () => ({ status: 401, body: 'unauthorized' });
    routes['POST login'] = () => ({ status: 204 });
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText('Token de acesso'), 'tok');
    routes['GET status'] = () => ({ body: STATUS });
    routes['GET plugins'] = () => ({ body: [] });
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    await screen.findAllByRole('navigation', { name: 'Principal' });
    expect(current(side())).toBe('Plugins');
  });

  it('401 em qualquer chamada depois de logado volta ao login', async () => {
    await boot();
    routes['GET tabs'] = () => ({ status: 401, body: 'unauthorized' });
    goto('#/logs');
    expect(await screen.findByRole('heading', { name: 'Entrar no dashboard' })).toBeTruthy();
  });
});

describe('App: rotas por hash', () => {
  it('abre a visão geral por padrão e navega por #/logs, #/plugins, #/config e #/mais', async () => {
    routes['GET plugins'] = () => ({ body: [] });
    await boot();
    expect(current(side())).toBe('Visão geral');
    goto('#/logs');
    expect(await screen.findByRole('log', { name: 'Logs do bot' })).toBeTruthy();
    expect(current(side())).toBe('Logs');
    expect(current(tabbar())).toBe('Mais');
    goto('#/plugins');
    expect(current(side())).toBe('Plugins');
    goto('#/config');
    expect(current(side())).toBe('Configuração');
    goto('#/mais');
    expect(screen.getByRole('heading', { level: 1, name: 'Mais' })).toBeTruthy();
    expect(current(tabbar())).toBe('Mais');
  });

  it('rota desconhecida cai na visão geral', async () => {
    window.location.hash = '#/nada';
    await boot();
    expect(current(tabbar())).toBe('Início');
  });
});

describe('App: abas de plugins', () => {
  it('lista as abas de GET api/tabs em Extensões e abre a aba pela rota', async () => {
    await boot();
    const link = await within(side()).findByRole('link', { name: 'Lembretes' });
    expect(link.getAttribute('href')).toBe('#/ext/reminders/lembretes');
    goto('#/ext/reminders/lembretes');
    expect(await screen.findByRole('heading', { level: 1, name: 'Lembretes' })).toBeTruthy();
    expect(current(side())).toBe('Lembretes');
    expect(current(tabbar())).toBe('Mais');
  });

  it('com falha em api/tabs o grupo Extensões some', async () => {
    routes['GET tabs'] = () => ({ status: 500, body: 'erro' });
    await boot();
    await waitFor(() => expect(calls).toContain('GET tabs'));
    expect(within(side()).queryByText('Extensões')).toBeNull();
  });

  it('a página Mais também lista as abas', async () => {
    window.location.hash = '#/mais';
    await boot();
    const main = screen.getByRole('main');
    expect(await within(main).findByRole('link', { name: /Lembretes/ })).toBeTruthy();
  });
});

describe('App: Sair, tema e rodapé', () => {
  it('Sair chama POST api/logout e mostra o login', async () => {
    routes['POST logout'] = () => ({ status: 204 });
    const user = userEvent.setup();
    await boot();
    await user.click(within(side()).getByRole('button', { name: 'Sair' }));
    expect(await screen.findByRole('heading', { name: 'Entrar no dashboard' })).toBeTruthy();
    expect(calls).toContain('POST logout');
  });

  it('o botão de tema alterna claro/escuro e guarda em localStorage', async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(
      screen.getAllByRole('button', { name: /Mudar para o tema/ })[0] as HTMLElement,
    );
    const theme = document.documentElement.getAttribute('data-theme');
    expect(['light', 'dark']).toContain(theme);
    expect(localStorage.getItem('bridger-dashboard-theme')).toBe(theme);
    await user.click(
      screen.getAllByRole('button', { name: /Mudar para o tema/ })[0] as HTMLElement,
    );
    expect(document.documentElement.getAttribute('data-theme')).not.toBe(theme);
  });

  it('o seletor de tema em Mais aplica a escolha salva', async () => {
    window.location.hash = '#/mais';
    const user = userEvent.setup();
    await boot();
    await user.selectOptions(screen.getByLabelText('Tema'), 'dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('bridger-dashboard-theme')).toBe('dark');
  });

  it('mostra as versões no rodapé depois do snapshot do WS', async () => {
    await boot();
    expect(within(side()).queryByText(/core 1\.2\.3/)).toBeNull();
    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.open();
    sockets[0]?.send({ type: 'snapshot', status: STATUS, logs: [] });
    expect(within(side()).getByText('core 1.2.3 · dashboard 4.5.6')).toBeTruthy();
    expect(screen.getByText('Luma · sessão principal')).toBeTruthy();
  });
});

describe('App: tempo real', () => {
  it('mostra os logs que chegam pelo WS e pausar fecha o socket', async () => {
    window.location.hash = '#/logs';
    const user = userEvent.setup();
    await boot();
    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.open();
    sockets[0]?.send({
      type: 'snapshot',
      status: STATUS,
      logs: [{ level: 'info', time: 1_700_000_000_000, message: 'conectado' }],
    });
    expect(within(screen.getByRole('log')).getByText(/conectado/)).toBeTruthy();
    await user.click(
      screen.getAllByRole('button', { name: 'Pausar atualização' })[0] as HTMLElement,
    );
    expect(sockets[0]?.closed).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Retomar atualização' }).length).toBeGreaterThan(
      0,
    );
  });

  it('queda do WS consulta api/status para descobrir sessão expirada', async () => {
    await boot();
    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.open();
    routes['GET status'] = () => ({ status: 401, body: 'unauthorized' });
    act(() => sockets[0]?.onclose?.());
    expect(await screen.findByRole('heading', { name: 'Entrar no dashboard' })).toBeTruthy();
  });
});
