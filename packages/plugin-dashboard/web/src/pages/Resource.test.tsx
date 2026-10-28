// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, me, renderApp, spec, useBase, useFakeEvents } from '#web/test-support.tsx';
import { cell, columns } from './Resource.tsx';

const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const meta = (operation: string, permission: string, extra: Record<string, unknown> = {}) => ({
  'x-resource': { plugin: 'rank', resource: 'ranking', operation, ...extra },
  'x-permission': permission,
});
const ROW = {
  type: 'object',
  properties: { nome: { type: 'string' }, id: { type: 'string' }, pontos: { type: 'number' } },
};

// O que o core publica para o `defineResource` do exemplo da doc (ADR 0134).
const PATHS = {
  '/api/resources/rank/ranking': {
    get: {
      ...meta('list', 'rank.read'),
      parameters: [
        { in: 'query', name: 'cursor', schema: { type: 'string' } },
        { in: 'query', name: 'limit', schema: { type: 'integer' } },
        { in: 'query', name: 'min', schema: { type: 'number' } },
      ],
      responses: {
        '200': json({ type: 'object', properties: { items: { type: 'array', items: ROW } } }),
      },
    },
    post: {
      ...meta('create', 'rank.write'),
      requestBody: json({
        type: 'object',
        properties: { nome: { type: 'string', title: 'Nome' } },
        required: ['nome'],
      }),
      responses: { '201': json(ROW) },
    },
  },
  '/api/resources/rank/ranking/{id}': {
    get: { ...meta('get', 'rank.read'), responses: { '200': json(ROW) } },
    delete: { ...meta('delete', 'rank.write'), responses: {} },
  },
  '/api/resources/rank/ranking/{id}/actions/zerar': {
    post: {
      ...meta('action', 'rank.reset', { action: 'zerar', confirm: true }),
      summary: 'Zerar pontos',
      requestBody: json({
        type: 'object',
        properties: { motivo: { type: 'string', title: 'Motivo' } },
      }),
      responses: {},
    },
  },
};

let confirm: ReturnType<typeof vi.fn>;
beforeEach(() => {
  useBase();
  useFakeEvents();
  confirm = vi.fn(() => true);
  vi.stubGlobal('confirm', confirm);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const api = (permissions: string[]) =>
  fakeApi({
    'GET /api/auth/me': me(permissions),
    'GET /openapi.json': spec(PATHS),
    'GET /api/resources/rank/ranking': ({ query }) =>
      query.get('cursor') === '2'
        ? { body: { items: [{ id: 'c', nome: 'Caio', pontos: 1 }] } }
        : { body: { items: [{ id: 'a', nome: 'Ana', pontos: 9 }], cursor: '2' } },
    'POST /api/resources/rank/ranking': ({ body }) => ({
      status: 201,
      body: { id: 'n', ...(body as object), pontos: 0 },
    }),
    'GET /api/resources/rank/ranking/a': () => ({ body: { id: 'a', nome: 'Ana', pontos: 9 } }),
    'POST /api/resources/rank/ranking/a/actions/zerar': () => ({ body: {} }),
    'DELETE /api/resources/rank/ranking/a': () => ({ body: { id: 'a' } }),
  });

describe('tela genérica de recurso', () => {
  it('lista com colunas do schema, filtra e pagina pelo cursor', async () => {
    const { calls } = api(['rank.read']);
    renderApp('#/recursos/rank/ranking');
    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['id', 'nome', 'pontos', '']);
    expect(within(table).getByText('Ana')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(await screen.findByText('Caio')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Anterior' }));
    expect(await screen.findByText('Ana')).toBeTruthy();

    await userEvent.type(screen.getByLabelText('min'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Filtrar' }));
    await waitFor(() => expect(calls.at(-1)?.query.get('min')).toBe('5'));
    // Sem `rank.write`, nada de criar.
    expect(screen.queryByRole('button', { name: 'Novo' })).toBeNull();
  });

  it('cria pelo form gerado do input', async () => {
    const { calls } = api(['rank.read', 'rank.write']);
    renderApp('#/recursos/rank/ranking');
    await userEvent.click(await screen.findByRole('button', { name: 'Novo' }));
    await userEvent.type(screen.getByLabelText(/Nome/), 'Bia');
    await userEvent.click(screen.getByRole('button', { name: 'Criar' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ nome: 'Bia' }),
    );
  });

  it('detalhe: mostra o item, roda a ação com confirmação e remove', async () => {
    const { calls } = api(['rank.read', 'rank.write', 'rank.reset']);
    renderApp('#/recursos/rank/ranking/a');
    expect(await screen.findByText('Ana')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Zerar pontos' }));
    await userEvent.type(screen.getByLabelText('Motivo'), 'temporada nova');
    confirm.mockReturnValueOnce(false);
    await userEvent.click(screen.getByRole('button', { name: 'Executar' }));
    expect(calls.some((c) => c.path.endsWith('/actions/zerar'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Executar' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/actions/zerar'))?.body).toEqual({
        motivo: 'temporada nova',
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Remover' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(window.location.hash).toBe('#/recursos/rank/ranking'));
  });

  it('esconde a ação sem a permissão dela', async () => {
    api(['rank.read', 'rank.write']);
    renderApp('#/recursos/rank/ranking/a');
    await screen.findByText('Ana');
    expect(screen.queryByText('Zerar pontos')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remover' })).toBeTruthy();
  });
});

it('columns põe o id primeiro e cell resume objetos', () => {
  expect(columns(ROW)).toEqual(['id', 'nome', 'pontos']);
  expect(cell(null)).toBe('—');
  expect(cell({ a: 1 })).toBe('{"a":1}');
  expect(cell('x'.repeat(90))).toBe('x'.repeat(90));
  expect(cell(['y'.repeat(90)])).toHaveLength(78);
});
