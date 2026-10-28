// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  FakeEventSource,
  fakeApi,
  me,
  renderApp,
  spec,
  useBase,
  useFakeEvents,
} from '#web/test-support.tsx';

const MANAGE = ['connection.read', 'connection.manage'];
let state: Record<string, unknown>;

beforeEach(() => {
  useBase();
  useFakeEvents();
  state = {
    status: 'connecting',
    transport: 'fake',
    pairing: true,
    account: null,
    reconnections: 2,
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const api = (permissions = MANAGE) =>
  fakeApi({
    'GET /api/auth/me': me(permissions),
    'GET /openapi.json': spec(),
    'GET /api/connection': () => ({ body: state }),
    'POST /api/connection/pairing-code': () => ({ body: { code: 'ABCD-1234' } }),
    'POST /api/connection/logout': () => ({ body: {} }),
  });

it('mostra o QR do stream e o esconde quando a conexão abre', async () => {
  api();
  renderApp();
  await screen.findByText('Esperando o QR do transport…');
  expect(FakeEventSource.last?.url).toContain(
    'types=connection.status,plugin.status,connection.qr,connection.pairing-code',
  );
  FakeEventSource.last?.emit('connection.qr', { qr: 'qr-1', expiresAt: Date.now() + 60_000 });
  expect(await screen.findByAltText('QR de pareamento')).toBeTruthy();

  state = { ...state, status: 'open', account: { id: '1', name: 'Luma', phone: null } };
  FakeEventSource.last?.emit('connection.status', { status: 'open' });
  expect(await screen.findByText('Luma')).toBeTruthy();
  expect(screen.queryByAltText('QR de pareamento')).toBeNull();
  expect(screen.getByText('Conectado')).toBeTruthy();
});

it('pede o código de pareamento com só os dígitos do telefone', async () => {
  const { calls } = api();
  renderApp();
  await userEvent.type(
    await screen.findByLabelText('Telefone com DDI e DDD'),
    '+55 (11) 99999-1234',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Parear por código' }));
  expect(await screen.findByText('ABCD-1234')).toBeTruthy();
  expect(calls.find((c) => c.path === '/api/connection/pairing-code')?.body).toEqual({
    phone: '5511999991234',
  });
});

it('desvincular pede confirmação', async () => {
  state = { ...state, status: 'open', account: { id: '1', name: 'Luma', phone: null } };
  const { calls } = api();
  const confirm = vi.fn(() => false);
  vi.stubGlobal('confirm', confirm);
  renderApp();
  await userEvent.click(await screen.findByRole('button', { name: 'Desvincular número' }));
  expect(confirm).toHaveBeenCalled();
  expect(calls.some((c) => c.path === '/api/connection/logout')).toBe(false);

  confirm.mockReturnValue(true);
  await userEvent.click(screen.getByRole('button', { name: 'Desvincular número' }));
  await waitFor(() => expect(calls.some((c) => c.path === '/api/connection/logout')).toBe(true));
});

it('só com connection.read não há QR, pareamento nem logout', async () => {
  api(['connection.read']);
  renderApp();
  await screen.findByText('Conectando');
  expect(screen.queryByText('Parear')).toBeNull();
  expect(FakeEventSource.last?.url).not.toContain('connection.qr');
});
