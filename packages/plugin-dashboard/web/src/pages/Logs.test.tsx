// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEventSource,
  fakeApi,
  me,
  renderApp,
  spec,
  useBase,
  useFakeEvents,
} from '#web/test-support.tsx';
import { matches } from './Logs.tsx';

const line = (message: string, level = 'info', fields: Record<string, unknown> = {}) => ({
  level,
  time: 1_761_600_000_000,
  message,
  fields,
});

beforeEach(() => {
  useBase();
  useFakeEvents();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Logs', () => {
  it('mostra o histórico, pagina e acrescenta as linhas ao vivo no topo', async () => {
    const { calls } = fakeApi({
      'GET /api/auth/me': me(['logs.read', 'connection.read']),
      'GET /openapi.json': spec(),
      'GET /api/logs': ({ query }) =>
        query.get('before') === '7'
          ? { body: { logs: [line('antiga')] } }
          : { body: { logs: [line('recente')], next: 7 } },
    });
    renderApp('#/logs');
    expect(await screen.findByText(/recente/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Mais antigas' }));
    expect(await screen.findByText(/antiga/)).toBeTruthy();
    expect(calls.filter((c) => c.path === '/api/logs').map((c) => c.query.get('before'))).toEqual([
      null,
      '7',
    ]);

    FakeEventSource.last?.emit('log', { ...line('ao vivo'), time: 1_761_600_001_000 });
    const rows = screen.getByRole('log').textContent ?? '';
    expect(rows).toContain('ao vivo');
    expect(rows.indexOf('ao vivo')).toBeLessThan(rows.indexOf('recente'));
    // A linha que o histórico já trouxe não aparece duas vezes.
    FakeEventSource.last?.emit('log', line('recente'));
    expect(screen.getAllByText(/recente/)).toHaveLength(1);
  });

  it('filtra pela API e aplica o mesmo filtro ao vivo', async () => {
    const { calls } = fakeApi({
      'GET /api/auth/me': me(['logs.read', 'connection.read']),
      'GET /openapi.json': spec(),
      'GET /api/logs': () => ({ body: { logs: [] } }),
    });
    renderApp('#/logs');
    await userEvent.selectOptions(await screen.findByLabelText('Nível mínimo'), 'warn');
    await userEvent.type(screen.getByLabelText('Plugin'), 'ia');
    await userEvent.click(screen.getByRole('button', { name: 'Filtrar' }));
    await waitFor(() => expect(calls.at(-1)?.query.toString()).toBe('level=warn&plugin=ia'));
    FakeEventSource.last?.emit('log', line('info do ia', 'info', { plugin: 'ia' }));
    FakeEventSource.last?.emit('log', line('erro do ia', 'error', { plugin: 'ia' }));
    expect(screen.queryByText(/info do ia/)).toBeNull();
    expect(screen.getByText(/erro do ia/)).toBeTruthy();
  });
});

it('matches segue o nível mínimo e os campos', () => {
  const warn = line('x', 'warn', { plugin: 'ia', event: 'e' }) as Parameters<typeof matches>[0];
  expect(matches(warn, { level: 'warn' })).toBe(true);
  expect(matches(warn, { level: 'error' })).toBe(false);
  expect(matches(warn, { plugin: 'outro' })).toBe(false);
  expect(matches(warn, { event: 'e', plugin: 'ia' })).toBe(true);
});
