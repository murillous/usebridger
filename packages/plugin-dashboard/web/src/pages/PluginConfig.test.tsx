// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  fakeApi,
  me,
  problem,
  renderApp,
  spec,
  useBase,
  useFakeEvents,
} from '#web/test-support.tsx';

const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    model: { type: 'string', title: 'Modelo' },
    apiKey: { type: 'string', title: 'Chave', minLength: 16, secret: true, writeOnly: true },
    region: { type: 'string', title: 'Região' },
  },
};
const CONFIG = {
  view: {
    config: { model: 'gpt-4o', apiKey: '********', region: 'br' },
    messages: {},
    sources: { model: 'default', apiKey: 'override', region: 'env' },
  },
  schema: SCHEMA,
  secretsWritable: true,
};

beforeEach(() => {
  useBase();
  useFakeEvents();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const routes = (put: () => ReturnType<typeof problem>) =>
  fakeApi({
    'GET /api/auth/me': me(['config.read', 'config.write']),
    'GET /openapi.json': spec(),
    'GET /api/plugins/ia/config': () => ({ body: CONFIG }),
    'PUT /api/plugins/ia/config': put,
  });

it('gera o form do schema e salva só os overrides, sem a máscara do segredo', async () => {
  const { calls } = routes(() => ({ body: CONFIG }));
  renderApp('#/plugins/ia');
  const model = await screen.findByLabelText('Modelo');
  // Campo do env: só leitura, com a origem.
  expect((screen.getByLabelText('Região') as HTMLInputElement).readOnly).toBe(true);
  expect(screen.getByText(/Definido no ambiente/)).toBeTruthy();
  expect((screen.getByLabelText('Chave') as HTMLInputElement).type).toBe('password');

  await userEvent.clear(model);
  await userEvent.type(model, 'gpt-5');
  await userEvent.click(screen.getByRole('button', { name: 'Salvar e recarregar' }));
  await screen.findByText('Config salva; o plugin recarregou.');
  expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ model: 'gpt-5' });
});

it('erro 400 da API aparece no campo', async () => {
  routes(() =>
    problem(400, 'config inválida', [
      { in: 'body', path: 'model', message: 'modelo desconhecido', code: 'custom' },
    ]),
  );
  renderApp('#/plugins/ia');
  await userEvent.type(await screen.findByLabelText('Modelo'), 'x');
  await userEvent.click(screen.getByRole('button', { name: 'Salvar e recarregar' }));
  await waitFor(() => expect(screen.getByText('modelo desconhecido')).toBeTruthy());
  expect(screen.getByRole('alert').textContent).toContain('config inválida');
});

it('sem config.write o botão de salvar fica desligado', async () => {
  fakeApi({
    'GET /api/auth/me': me(['config.read']),
    'GET /openapi.json': spec(),
    'GET /api/plugins/ia/config': () => ({ body: CONFIG }),
  });
  renderApp('#/plugins/ia');
  const save = await screen.findByRole('button', { name: 'Salvar e recarregar' });
  expect((save as HTMLButtonElement).disabled).toBe(true);
});
