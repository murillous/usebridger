// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigResponse, PluginRow } from '#web/lib/types.ts';
import { Config } from './Config.tsx';

type Reply = { status?: number; body?: unknown };
let routes: Record<string, (init?: RequestInit) => Reply>;
const calls: { path: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  routes = {};
  calls.length = 0;
  location.hash = '';
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = url.replace(/^api\//, '');
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const reply = routes[`${method} ${path}`]?.(init) ?? { status: 404, body: 'sem rota' };
    const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status ?? 200 });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = (name: string): PluginRow => ({
  name,
  version: '1.0.0',
  origin: 'npm',
  status: 'loaded',
});
const schema = (settable: boolean) => ({
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Nome' },
    apiKey: {
      type: 'string',
      title: 'Chave',
      secret: true,
      'x-bridger-override': false,
      ...(settable && { 'x-bridger-set-secret': true }),
    },
  },
});
const config = (source: string | undefined, writable = true): ConfigResponse => ({
  schema: schema(writable),
  secretsWritable: writable,
  view: {
    config: { name: 'luma', apiKey: '****abcd' },
    messages: {},
    sources: { name: 'override', ...(source && { apiKey: source }) },
  },
});

const open = async (cfg: ConfigResponse, dependents = false) => {
  routes['GET plugins'] = () => ({
    body: [row('ai'), ...(dependents ? [{ ...row('dep'), dependsOn: { ai: '*' } }] : [])],
  });
  routes['GET config/ai'] = () => ({ body: cfg });
  routes['GET config/dep'] = () => ({ body: cfg });
  render(<Config selected="ai" />);
  await screen.findByRole('heading', { level: 2, name: 'ai' });
};

describe('Config: secret cifrado', () => {
  it('Substituir abre input de senha e salva por PUT, sem exibir o valor', async () => {
    const user = userEvent.setup();
    await open(config('secret'));
    routes['PUT config/ai/secrets/apiKey'] = () => ({
      body: { plugin: row('ai'), dependents: [], teardownErrors: [] },
    });
    await user.click(screen.getByRole('button', { name: 'Substituir Chave' }));
    const input = screen.getByLabelText('Novo valor de Chave') as HTMLInputElement;
    expect(input.type).toBe('password');
    await user.type(input, 'valor-novo');
    await user.click(screen.getByRole('button', { name: 'Salvar secret' }));
    await screen.findByText(/Config salva e ai recarregado/);
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({ value: 'valor-novo' });
    expect(document.body.textContent).not.toContain('valor-novo');
  });

  it('Remover aparece com fonte secret e chama DELETE', async () => {
    const user = userEvent.setup();
    await open(config('secret'));
    routes['DELETE config/ai/secrets/apiKey'] = () => ({
      body: { plugin: row('ai'), dependents: [], teardownErrors: [] },
    });
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    vi.stubGlobal('confirm', confirm);
    await user.click(screen.getByRole('button', { name: 'Remover Chave' }));
    // Recusar a confirmação não chama o servidor; o texto traz o aviso de reload.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(String(confirm.mock.calls[0]?.[0])).toContain('Salvar recarrega ai');
    await user.click(screen.getByRole('button', { name: 'Remover Chave' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    await screen.findByText(/Config salva e ai recarregado/);
  });

  it('fonte env ou file: mostra quem define e não há botões', async () => {
    await open(config('env'));
    expect(screen.getByText('Definido por env')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Substituir|Remover Chave/ })).toBeNull();
    cleanup();
    await open(config('file'));
    expect(screen.getByText('Definido pelo arquivo')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Substituir/ })).toBeNull();
  });

  it('recusa shadowed do servidor aparece no campo', async () => {
    const user = userEvent.setup();
    await open(config(undefined));
    routes['PUT config/ai/secrets/apiKey'] = () => ({
      status: 409,
      body: { error: 'shadowed', issues: [{ path: 'apiKey', message: 'definido pelo env X' }] },
    });
    await user.click(screen.getByRole('button', { name: 'Substituir Chave' }));
    await user.type(screen.getByLabelText('Novo valor de Chave'), 'v');
    await user.click(screen.getByRole('button', { name: 'Salvar secret' }));
    expect((await screen.findByRole('alert')).textContent).toContain('definido pelo env X');
  });

  it('sem chave mestra: mostra o motivo e não oferece Substituir', async () => {
    await open(config(undefined, false));
    expect(screen.getByText(/BRIDGER_SECRET_KEY/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Substituir/ })).toBeNull();
  });

  it('o aviso de reload cita os dependentes', async () => {
    await open(config('secret'), true);
    expect(screen.getAllByText(/Salvar recarrega ai e 1 dependente/).length).toBeGreaterThan(1);
  });

  it('envelope ilegível (view nula): Remover aparece, mesmo sem chave mestra', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', () => true);
    await open({
      schema: schema(false),
      secretsWritable: false,
      view: null,
      issues: [{ path: 'apiKey', message: 'segredo salvo não decifra', kind: 'undecryptable' }],
    });
    expect(screen.queryByRole('button', { name: /Substituir/ })).toBeNull();
    routes['DELETE config/ai/secrets/apiKey'] = () => ({
      body: { plugin: row('ai'), dependents: [], teardownErrors: [] },
    });
    await user.click(screen.getByRole('button', { name: 'Remover Chave' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });

  it('acessibilidade: foco no input, erro ligado por aria-describedby, Cancelar limpa e devolve o foco', async () => {
    const user = userEvent.setup();
    await open(config(undefined));
    routes['PUT config/ai/secrets/apiKey'] = () => ({
      status: 400,
      body: { error: 'invalid', issues: [{ path: 'apiKey', message: 'valor ruim' }] },
    });
    await user.click(screen.getByRole('button', { name: 'Substituir Chave' }));
    const input = screen.getByLabelText('Novo valor de Chave') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.autocomplete).toBe('new-password');
    await user.type(input, 'abc');
    await user.click(screen.getByRole('button', { name: 'Salvar secret' }));
    const alert = await screen.findByRole('alert');
    expect(input.getAttribute('aria-describedby')).toBe(alert.id);
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Substituir Chave' }));
    await user.click(screen.getByRole('button', { name: 'Substituir Chave' }));
    expect((screen.getByLabelText('Novo valor de Chave') as HTMLInputElement).value).toBe('');
  });

  it('409 sem issues (reload falhou): recarrega a tela', async () => {
    const user = userEvent.setup();
    await open(config(undefined));
    routes['PUT config/ai/secrets/apiKey'] = () => ({ status: 409, body: 'reload falhou' });
    const before = calls.filter((c) => c.path === 'config/ai').length;
    await user.click(screen.getByRole('button', { name: 'Substituir Chave' }));
    await user.type(screen.getByLabelText('Novo valor de Chave'), 'v');
    await user.click(screen.getByRole('button', { name: 'Salvar secret' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.path === 'config/ai').length).toBeGreaterThan(before),
    );
  });
});
