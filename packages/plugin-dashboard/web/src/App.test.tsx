// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEventSource,
  fakeApi,
  me,
  problem,
  renderApp,
  spec,
  useBase,
  useFakeEvents,
} from './test-support.tsx';

const CONNECTION = {
  status: 'open',
  transport: 'fake',
  pairing: true,
  account: { id: '1', name: 'Luma', phone: '5511' },
  reconnections: 0,
};

beforeEach(() => {
  useBase();
  useFakeEvents();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const nav = () => screen.getByRole('navigation', { name: 'Principal' });
const findNav = () => screen.findByRole('navigation', { name: 'Principal' });

describe('App', () => {
  it('sem sessão mostra o login; entrar abre o painel', async () => {
    let logged = false;
    const { calls } = fakeApi({
      'GET /api/auth/me': () =>
        logged ? me(['connection.read'])({} as never) : problem(401, 'sem sessão'),
      'POST /api/auth/login': () => {
        logged = true;
        return { body: { user: {} } };
      },
      'GET /openapi.json': spec(),
      'GET /api/connection': () => ({ body: CONNECTION }),
    });
    renderApp();
    await userEvent.type(await screen.findByLabelText('E-mail'), 'dona@exemplo.com');
    await userEvent.type(screen.getByLabelText('Senha'), 'uma senha longa');
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(await screen.findByRole('heading', { name: 'Conexão' })).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/auth/login')?.body).toEqual({
      email: 'dona@exemplo.com',
      password: 'uma senha longa',
    });
  });

  it('senha errada mostra o erro da API e fica no login', async () => {
    fakeApi({
      'GET /api/auth/me': () => problem(401, 'sem sessão'),
      'POST /api/auth/login': () => problem(401, 'e-mail ou senha inválidos'),
    });
    renderApp();
    await userEvent.type(await screen.findByLabelText('E-mail'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Senha'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect((await screen.findByRole('alert')).textContent).toContain('e-mail ou senha inválidos');
  });

  it('a navegação e o stream seguem as permissões', async () => {
    fakeApi({
      'GET /api/auth/me': me(['logs.read', 'audit.read']),
      'GET /openapi.json': spec(),
      'GET /api/logs': () => ({ body: { logs: [] } }),
    });
    renderApp('#/logs');
    await screen.findByRole('heading', { name: 'Logs' });
    const links = within(nav())
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(links).toEqual(['Logs', 'Auditoria', 'Minha conta']);
    // O `GET /events` pede `connection.read`: sem ela, nada de stream (seria 403 em laço).
    expect(FakeEventSource.last).toBeUndefined();
    expect(screen.getByText('sem tempo real')).toBeTruthy();
  });

  it('sem a auth (404 no /auth/me) mostra tudo, sem login nem contas', async () => {
    fakeApi({
      'GET /openapi.json': spec(),
      'GET /api/connection': () => ({ body: CONNECTION }),
    });
    renderApp();
    await screen.findByRole('heading', { name: 'Conexão' });
    expect(within(nav()).queryByText('Usuários')).toBeNull();
    expect(within(nav()).queryByText('Sair')).toBeNull();
    expect(within(nav()).getByText('API sem auth (loopback)')).toBeTruthy();
  });

  it('401 no meio do uso volta ao login', async () => {
    let expired = false;
    fakeApi({
      'GET /api/auth/me': me(['connection.read', 'plugins.read']),
      'GET /openapi.json': spec(),
      'GET /api/connection': () => ({ body: CONNECTION }),
      'GET /api/plugins': () => (expired ? problem(401, 'sessão expirada') : undefined),
    });
    renderApp();
    await screen.findByRole('heading', { name: 'Conexão' });
    expired = true;
    await userEvent.click(within(nav()).getByText('Plugins'));
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeTruthy();
  });

  it('recurso de plugin entra na navegação só com a permissão de leitura', async () => {
    const paths = {
      '/api/resources/rank/ranking': {
        get: {
          'x-resource': { plugin: 'rank', resource: 'ranking', operation: 'list' },
          'x-permission': 'rank.read',
          responses: {},
        },
      },
    };
    fakeApi({
      'GET /api/auth/me': me(['connection.read', 'rank.read']),
      'GET /openapi.json': spec(paths),
      'GET /api/connection': () => ({ body: CONNECTION }),
    });
    renderApp();
    expect(await within(await findNav()).findByText('ranking')).toBeTruthy();
    cleanup();

    fakeApi({
      'GET /api/auth/me': me(['connection.read']),
      'GET /openapi.json': spec(paths),
      'GET /api/connection': () => ({ body: CONNECTION }),
    });
    renderApp();
    await screen.findByRole('heading', { name: 'Conexão' });
    await waitFor(() => expect(within(nav()).queryByText('Recursos de plugins')).toBeNull());
  });

  it('Métricas aparece quando a spec tem as rotas do plugin-metrics', async () => {
    fakeApi({
      'GET /api/auth/me': me(['connection.read', 'metrics.read']),
      'GET /openapi.json': spec({ '/api/plugins/metrics/catalog': { get: {} } }),
      'GET /api/connection': () => ({ body: CONNECTION }),
    });
    renderApp();
    expect(await within(await findNav()).findByText('Métricas')).toBeTruthy();
  });
});
