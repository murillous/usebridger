// @vitest-environment happy-dom
// Telas de administração e conta: Usuários, API keys, Auditoria, Métricas e Minha conta.
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fakeApi, me, renderApp, spec, useBase, useFakeEvents } from '#web/test-support.tsx';
import { rowValue } from './Metrics.tsx';
import { inviteLink } from './Users.tsx';

const USER = {
  id: 'u2',
  name: 'Bia',
  email: 'bia@exemplo.com',
  role: 'viewer',
  status: 'active',
  createdAt: '2026-10-01T00:00:00Z',
  lastLoginAt: null,
  mustChangePassword: false,
  pendingInvite: true,
};

beforeEach(() => {
  useBase();
  useFakeEvents();
  vi.stubGlobal('confirm', () => true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('Usuários: convidar mostra o link do convite uma vez e muda o papel', async () => {
  const { calls } = fakeApi({
    'GET /api/auth/me': me(['users.manage']),
    'GET /openapi.json': spec(),
    'GET /api/users': () => ({ body: { users: [USER] } }),
    'POST /api/users': () => ({
      status: 201,
      body: { user: USER, invite: { token: 'tok+1', expiresAt: '2026-10-03T00:00:00Z' } },
    }),
    'PATCH /api/users/u2': () => ({ body: { user: { ...USER, role: 'admin' } } }),
  });
  renderApp('#/usuarios');
  await userEvent.type(await screen.findByLabelText('Nome'), 'Caio');
  await userEvent.type(screen.getByLabelText('E-mail'), 'caio@exemplo.com');
  await userEvent.click(screen.getByRole('button', { name: 'Convidar' }));
  expect(
    await screen.findByText('http://localhost/plugins/dashboard/#/convite?token=tok%2B1'),
  ).toBeTruthy();
  expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
    name: 'Caio',
    email: 'caio@exemplo.com',
    role: 'viewer',
  });

  await userEvent.selectOptions(screen.getByLabelText('Papel de Bia'), 'admin');
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ role: 'admin' }),
  );
});

it('API keys: o escopo só oferece as permissões de quem cria e o segredo aparece uma vez', async () => {
  const { calls } = fakeApi({
    'GET /api/auth/me': me(['keys.manage', 'logs.read']),
    'GET /openapi.json': spec(),
    'GET /api/keys': () => ({ body: { keys: [] } }),
    'POST /api/keys': () => ({
      status: 201,
      body: {
        id: 'k1',
        name: 'backend',
        permissions: ['logs.read'],
        createdBy: 'u1',
        createdAt: '2026-10-01T00:00:00Z',
        lastUsedAt: null,
        revokedAt: null,
        secret: 'brk_segredo',
      },
    }),
  });
  renderApp('#/chaves');
  const scope = await screen.findByRole('group', { name: 'Permissões' });
  expect(within(scope).getAllByRole('checkbox')).toHaveLength(2);
  const create = screen.getByRole('button', { name: 'Criar chave' }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  await userEvent.type(screen.getByLabelText('Nome'), 'backend');
  await userEvent.click(within(scope).getByLabelText('logs.read'));
  await userEvent.click(create);
  expect(await screen.findByText('brk_segredo')).toBeTruthy();
  expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
    name: 'backend',
    permissions: ['logs.read'],
  });
});

it('Auditoria: filtra, verifica a cadeia e exporta com os filtros', async () => {
  const { calls } = fakeApi({
    'GET /api/auth/me': me(['audit.read']),
    'GET /openapi.json': spec(),
    'GET /api/audit': () => ({
      body: {
        events: [
          {
            v: 1,
            eventId: 'e1',
            seq: 1,
            at: '2026-10-01T00:00:00Z',
            actor: { kind: 'user', id: 'u1', name: 'Dona' },
            action: 'kernel.config.update',
            outcome: 'success',
            session: 'default',
            actorId: 'u1',
            prevHash: 'x',
            hash: 'y',
          },
        ],
      },
    }),
    'POST /api/audit/verify': () => ({ body: { ok: false, checked: 3, brokenAt: 2 } }),
  });
  renderApp('#/auditoria');
  expect(await screen.findByText('kernel.config.update')).toBeTruthy();
  await userEvent.type(screen.getByLabelText('Ação'), 'kernel.auth.login');
  await userEvent.click(screen.getByRole('button', { name: 'Filtrar' }));
  await waitFor(() => expect(calls.at(-1)?.query.get('action')).toBe('kernel.auth.login'));
  expect(screen.getByRole('link', { name: 'Exportar CSV' }).getAttribute('href')).toBe(
    'http://localhost/api/audit/export?format=csv&action=kernel.auth.login',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Verificar cadeia' }));
  expect(await screen.findByText('Cadeia quebrada no evento 2.')).toBeTruthy();
});

it('Métricas: lê o catálogo e pede o total do período', async () => {
  const { calls } = fakeApi({
    'GET /api/auth/me': me(['metrics.read']),
    'GET /openapi.json': spec({ '/api/plugins/metrics/catalog': { get: {} } }),
    'GET /api/plugins/metrics/catalog': () => ({
      body: {
        metrics: [
          { name: 'msgs_total', type: 'counter', help: 'Mensagens', labelNames: [], live: true },
        ],
      },
    }),
    'GET /api/plugins/metrics/query': () => ({
      body: { rows: [{ type: 'counter', period: '2026-10-01', labels: {}, value: 42 }] },
    }),
  });
  renderApp('#/metricas');
  expect(await screen.findByText('42')).toBeTruthy();
  const query = calls.find((c) => c.path === '/api/plugins/metrics/query')?.query;
  expect(query?.get('name')).toBe('msgs_total');
  expect(query?.get('groupBy')).toBe('');
  expect(query?.get('granularity')).toBe('day');
});

it('Minha conta: troca a senha e encerrar a sessão atual é sair', async () => {
  const { calls } = fakeApi({
    'GET /api/auth/me': me([]),
    'GET /openapi.json': spec(),
    'GET /api/auth/sessions': () => ({
      body: {
        sessions: [
          {
            id: 's1',
            createdAt: '2026-10-01T00:00:00Z',
            lastSeenAt: '2026-10-01T00:00:00Z',
            expiresAt: '2026-10-08T00:00:00Z',
            current: true,
          },
        ],
      },
    }),
    'POST /api/auth/password': () => ({ body: {} }),
    'DELETE /api/auth/sessions/s1': () => ({ body: {} }),
  });
  renderApp('#/conta');
  await userEvent.type(await screen.findByLabelText('Senha atual'), 'velha senha longa');
  await userEvent.type(screen.getByLabelText('Senha nova'), 'nova senha longa');
  await userEvent.click(screen.getByRole('button', { name: 'Trocar senha' }));
  await screen.findByText('Senha trocada; as outras sessões foram encerradas.');
  expect(calls.find((c) => c.path === '/api/auth/password')?.body).toEqual({
    currentPassword: 'velha senha longa',
    newPassword: 'nova senha longa',
  });
  await userEvent.click(screen.getByRole('button', { name: 'Encerrar' }));
  expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeTruthy();
});

it('rowValue: soma do contador, média do histograma, último do gauge', () => {
  expect(rowValue({ type: 'counter', period: 'p', value: 3 })).toBe(3);
  expect(rowValue({ type: 'histogram', period: 'p', count: 4, sum: 2 })).toBe(0.5);
  expect(rowValue({ type: 'histogram', period: 'p', count: 0, sum: 0 })).toBe(0);
  expect(rowValue({ type: 'gauge', period: 'p', last: 7, max: 9 })).toBe(7);
});

it('inviteLink põe o token no hash, escapado', () => {
  expect(inviteLink('a b', 'https://h/sessions/x/plugins/dashboard/')).toBe(
    'https://h/sessions/x/plugins/dashboard/#/convite?token=a%20b',
  );
});

it('Plugins: desligar pede confirmação e chama o disable', async () => {
  const { calls } = fakeApi({
    'GET /api/auth/me': me(['plugins.read', 'plugins.manage', 'config.read']),
    'GET /openapi.json': spec(),
    'GET /api/plugins': () => ({
      body: {
        bootedAt: 1,
        plugins: [
          {
            name: 'ia',
            version: '1.0.0',
            status: 'loaded',
            dependsOn: {},
            services: [],
            contributions: [],
            setupMs: 3,
          },
          {
            name: 'off',
            version: '1.0.0',
            status: 'skipped',
            dependsOn: {},
            services: [],
            contributions: [],
            reason: { kind: 'disabled', message: 'desligado' },
          },
        ],
      },
    }),
    'POST /api/plugins/ia/disable': () => ({ body: { plugin: 'ia', dependents: [] } }),
  });
  renderApp('#/plugins');
  expect(await screen.findByText('desligado')).toBeTruthy();
  expect(screen.getAllByRole('link', { name: 'Config' })[0]?.getAttribute('href')).toBe(
    '#/plugins/ia',
  );
  await userEvent.click(screen.getByRole('switch', { name: 'Desligar ia' }));
  await waitFor(() => expect(calls.some((c) => c.path === '/api/plugins/ia/disable')).toBe(true));
});
