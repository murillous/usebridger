// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigResponse, PluginRow } from '#web/lib/types.ts';
import { Config } from './Config.tsx';

// O `api` chama `fetch('api/<caminho>')`: cada teste responde por "<MÉTODO> <caminho>", sem servidor.
type Reply = { status?: number; body?: unknown };
let routes: Record<string, (init?: RequestInit) => Reply | Promise<Reply>>;
const calls: { path: string; method: string; body: unknown }[] = [];
const puts = () => calls.filter((c) => c.method === 'PUT');

beforeEach(() => {
  routes = {};
  calls.length = 0;
  location.hash = '';
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = url.replace(/^api\//, '');
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const reply = (await routes[`${method} ${path}`]?.(init)) ?? { status: 404, body: 'sem rota' };
    const status = reply.status ?? 200;
    const text =
      reply.body === undefined
        ? ''
        : typeof reply.body === 'string'
          ? reply.body
          : JSON.stringify(reply.body);
    return new Response(status === 204 ? null : text, { status });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = (name: string, extra: Partial<PluginRow> = {}): PluginRow => ({
  name,
  version: '1.0.0',
  origin: 'npm',
  status: 'loaded',
  ...extra,
});

const SCHEMA = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', title: 'Nome', minLength: 2 },
    retries: { type: 'integer', title: 'Tentativas', minimum: 0, maximum: 10 },
    ratio: { type: 'number', title: 'Razão' },
    enabled: { type: 'boolean', title: 'Ativo' },
    mode: { type: 'string', enum: ['rapido', 'lento'], title: 'Modo' },
    tags: { type: 'array', items: { type: 'string' }, title: 'Tags' },
    labels: { type: 'object', additionalProperties: { type: 'string' }, title: 'Rótulos' },
    apiKey: { type: 'string', title: 'Chave', secret: true },
  },
};

const aiConfig = (over: Partial<ConfigResponse> = {}): ConfigResponse => ({
  schema: SCHEMA,
  view: {
    config: {
      name: 'luma',
      retries: 3,
      ratio: 0.5,
      enabled: false,
      mode: 'rapido',
      tags: ['a', 'b'],
      labels: { x: '1' },
      apiKey: '****abcd',
    },
    messages: { greet: 'oi', other: 'tchau' },
    sources: {
      name: 'override',
      retries: 'file',
      'labels.x': 'override',
      apiKey: 'env',
      'messages.greet': 'override',
    },
  },
  ...over,
});

const setup = (rows: PluginRow[], configs: Record<string, ConfigResponse>, selected?: string) => {
  routes['GET plugins'] = () => ({ body: rows });
  for (const [name, cfg] of Object.entries(configs)) {
    routes[`GET config/${name}`] = () => ({ body: cfg });
  }
  render(<Config selected={selected} />);
};

const form = async () => screen.findByRole('heading', { level: 2, name: 'ai' });
const saveButton = () => screen.getByRole('button', { name: 'Salvar e recarregar' });

describe('Config: lista e seleção de plugin', () => {
  it('lista os plugins na navegação e no select, e carrega o primeiro', async () => {
    setup([row('ai'), row('metrics')], { ai: aiConfig(), metrics: aiConfig() });
    await form();
    const nav = screen.getByRole('navigation', { name: 'Plugins' });
    expect(
      within(nav)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['ai', 'metrics']);
    expect(within(nav).getByRole('button', { name: 'ai' }).getAttribute('aria-current')).toBe(
      'true',
    );
    const select = screen.getByLabelText('Plugin') as HTMLSelectElement;
    expect(select.value).toBe('ai');
    expect(within(select).getAllByRole('option').length).toBe(2);
  });

  it('clicar na lista ou trocar o select muda o hash', async () => {
    const user = userEvent.setup();
    setup([row('ai'), row('metrics')], { ai: aiConfig(), metrics: aiConfig() });
    await form();
    await user.click(screen.getByRole('button', { name: 'metrics' }));
    expect(location.hash).toBe('#/config/metrics');
    await user.selectOptions(screen.getByLabelText('Plugin'), 'ai');
    expect(location.hash).toBe('#/config/ai');
  });

  it('abre o plugin do hash e cai no primeiro se for desconhecido', async () => {
    setup([row('ai'), row('metrics')], { ai: aiConfig(), metrics: aiConfig() }, 'metrics');
    await screen.findByRole('heading', { level: 2, name: 'metrics' });
    cleanup();
    render(<Config selected="nao-existe" />);
    await form();
  });

  it('mostra badges de erro e de setup falho', async () => {
    setup([row('ai'), row('metrics', { status: 'skipped', reason: { kind: 'setup-failed' } })], {
      ai: aiConfig({
        issues: [
          { path: 'name', message: 'x' },
          { path: 'retries', message: 'y' },
        ],
      }),
      metrics: aiConfig(),
    });
    await form();
    const nav = screen.getByRole('navigation', { name: 'Plugins' });
    await waitFor(() =>
      expect(within(nav).getByRole('button', { name: /^ai\s*2 erros$/ })).toBeTruthy(),
    );
    expect(within(nav).getByRole('button', { name: /^metrics\s*falhou$/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'metrics · falhou' })).toBeTruthy();
  });

  it('esconde da lista os plugins sem schema', async () => {
    setup([row('ai'), row('logs'), row('metrics')], {
      ai: aiConfig(),
      logs: { schema: null, view: { config: {}, messages: {}, sources: {} } },
      metrics: aiConfig(),
    });
    await form();
    const nav = screen.getByRole('navigation', { name: 'Plugins' });
    await waitFor(() =>
      expect(
        within(nav)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['ai', 'metrics']),
    );
    expect(within(screen.getByLabelText('Plugin')).getAllByRole('option').length).toBe(2);
  });

  it('avisa quando nenhum plugin declara config', async () => {
    setup([row('logs')], {
      logs: { schema: null, view: { config: {}, messages: {}, sources: {} } },
    });
    expect(await screen.findByText('Nenhum plugin declara config.')).toBeTruthy();
  });
});

describe('Config: formulário gerado do schema', () => {
  it('cria um controle por tipo, preenchido com a view', async () => {
    setup([row('ai')], { ai: aiConfig() });
    await form();
    expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('luma');
    expect((screen.getByLabelText('Tentativas') as HTMLInputElement).value).toBe('3');
    expect((screen.getByLabelText('Razão') as HTMLInputElement).value).toBe('0.5');
    expect((screen.getByLabelText('Ativo') as HTMLInputElement).checked).toBe(false);
    const mode = screen.getByLabelText('Modo') as HTMLSelectElement;
    expect(mode.value).toBe('rapido');
    expect(
      within(mode)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['—', 'rapido', 'lento']);
    const tags = screen.getByRole('group', { name: 'Tags' });
    expect(
      within(tags)
        .getAllByRole('textbox')
        .map((i) => (i as HTMLInputElement).value),
    ).toEqual(['a', 'b']);
    const labels = screen.getByRole('group', { name: 'Rótulos' });
    expect((within(labels).getByLabelText('Rótulos, chave 1') as HTMLInputElement).value).toBe('x');
    expect((within(labels).getByLabelText('Rótulos, valor 1') as HTMLInputElement).value).toBe('1');
  });

  it('mostra a dica do tipo e a origem file do campo', async () => {
    setup([row('ai')], { ai: aiConfig() });
    await form();
    expect(screen.getByText('z.int().min(0).max(10) · vem do schema')).toBeTruthy();
    expect(screen.getByText(/definido no arquivo de config/)).toBeTruthy();
  });

  it('salvar começa desabilitado; editar habilita e descartar restaura', async () => {
    const user = userEvent.setup();
    setup([row('ai')], { ai: aiConfig() });
    await form();
    const save = saveButton() as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.type(screen.getByLabelText('Nome'), '2');
    expect(save.disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Descartar' }));
    expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('luma');
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('valida limites localmente, sem esperar o 400', async () => {
    const user = userEvent.setup();
    setup([row('ai')], { ai: aiConfig() });
    await form();
    const retries = screen.getByLabelText('Tentativas');
    await user.clear(retries);
    await user.type(retries, '11');
    expect(screen.getByRole('alert').textContent).toBe('Deve ser menor ou igual a 10');
    expect(retries.getAttribute('aria-invalid')).toBe('true');
  });

  it('lista editável: remove e adiciona itens', async () => {
    const user = userEvent.setup();
    setup([row('ai')], { ai: aiConfig() });
    await form();
    routes['PUT config/ai'] = () => ({ body: null });
    await user.click(screen.getByRole('button', { name: 'Remover item 1 de Tags' }));
    await user.click(screen.getByRole('button', { name: 'Adicionar item' }));
    await user.type(screen.getByLabelText('Tags, item 2'), 'c');
    await user.click(saveButton());
    await waitFor(() => expect(puts().length).toBe(1));
    expect(puts()[0]?.body).toMatchObject({ tags: ['b', 'c'] });
  });
});

describe('Config: secret', () => {
  it('é máscara só leitura com a origem, e nunca vai no PUT', async () => {
    const user = userEvent.setup();
    setup([row('ai')], { ai: aiConfig() });
    await form();
    const key = screen.getByLabelText(/^Chave/) as HTMLInputElement;
    expect(key.value).toBe('****abcd');
    expect(key.readOnly).toBe(true);
    expect(key.type).not.toBe('password');
    expect(screen.getByText(/Definida por BRIDGER_AI__API_KEY\./)).toBeTruthy();
    routes['PUT config/ai'] = () => ({ body: null });
    await user.type(screen.getByLabelText('Nome'), '!');
    await user.click(saveButton());
    await waitFor(() => expect(puts().length).toBe(1));
    expect(puts()[0]?.body).not.toHaveProperty('apiKey');
  });
});

describe('Config: salvar', () => {
  it('envia o editado e o que já era override (messages e chaves de record), nada mais', async () => {
    const user = userEvent.setup();
    setup([row('ai')], { ai: aiConfig() });
    await form();
    routes['PUT config/ai'] = () => ({
      body: { plugin: row('ai'), dependents: [row('metrics')], teardownErrors: [] },
    });
    const name = screen.getByLabelText('Nome');
    await user.clear(name);
    await user.type(name, 'nova');
    await user.click(screen.getByLabelText('Ativo'));
    await user.click(saveButton());
    await waitFor(() => expect(puts().length).toBe(1));
    // `retries` é do arquivo e `messages.other` não é override: ficam de fora.
    expect(puts()[0]).toEqual({
      path: 'config/ai',
      method: 'PUT',
      body: { name: 'nova', enabled: true, labels: { x: '1' }, messages: { greet: 'oi' } },
    });
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Config salva e ai recarregado (dependentes: metrics)');
  });

  it('edita o par chave/valor do record', async () => {
    const user = userEvent.setup();
    setup([row('ai')], { ai: aiConfig() });
    await form();
    routes['PUT config/ai'] = () => ({ body: null });
    await user.click(screen.getByRole('button', { name: 'Adicionar par' }));
    await user.type(screen.getByLabelText('Rótulos, chave 2'), 'y');
    await user.type(screen.getByLabelText('Rótulos, valor 2'), '2');
    await user.click(saveButton());
    await waitFor(() => expect(puts().length).toBe(1));
    expect(puts()[0]?.body).toMatchObject({ labels: { x: '1', y: '2' } });
  });

  it('400: erro junto do campo e erro órfão em lista', async () => {
    const user = userEvent.setup();
    setup([row('ai')], { ai: aiConfig() });
    await form();
    routes['PUT config/ai'] = () => ({
      status: 400,
      body: {
        issues: [
          { path: 'name', message: 'Muito curto' },
          { path: 'outro.campo', message: 'Não reconhecido' },
        ],
      },
    });
    await user.type(screen.getByLabelText('Nome'), '!');
    await user.click(saveButton());
    expect((await screen.findAllByRole('alert')).map((a) => a.textContent)).toContain(
      'Config recusada. Corrija os campos marcados.',
    );
    const name = screen.getByLabelText('Nome');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    const errId = (name.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .find((i) => i.endsWith('-err'));
    expect(document.getElementById(errId ?? '')?.textContent).toBe('Muito curto');
    expect(screen.getByText('outro.campo').parentElement?.textContent).toBe(
      'outro.campo: Não reconhecido',
    );
  });

  it('500 no PUT aparece como alerta', async () => {
    const user = userEvent.setup();
    setup([row('ai')], { ai: aiConfig() });
    await form();
    routes['PUT config/ai'] = () => ({ status: 500, body: 'quebrou' });
    await user.type(screen.getByLabelText('Nome'), '!');
    await user.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toBe('500: quebrou');
  });
});

describe('Config: config inválida (view: null)', () => {
  const invalid = (): ConfigResponse => ({
    schema: SCHEMA,
    view: null,
    issues: [
      { path: 'retries', message: 'Required' },
      { path: '', message: 'raiz ruim' },
    ],
  });

  it('avisa, lista os erros e marca a origem do secret como desconhecida', async () => {
    setup([row('ai')], { ai: invalid() });
    await form();
    const warn = screen
      .getAllByRole('alert')
      .find((a) => a.textContent?.includes('A config atual é inválida'));
    expect(warn?.textContent).toContain('retries: Required');
    expect(warn?.textContent).toContain('(raiz): raiz ruim');
    expect(screen.getByText(/Origem desconhecida/)).toBeTruthy();
  });

  it('pede confirmação antes de salvar; recusar não envia', async () => {
    const user = userEvent.setup();
    setup([row('ai')], { ai: invalid() });
    await form();
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    await user.type(screen.getByLabelText('Nome'), 'ab');
    await user.click(saveButton());
    expect(confirm).toHaveBeenCalledOnce();
    expect(puts().length).toBe(0);
  });

  it('confirmando, envia o que foi preenchido', async () => {
    const user = userEvent.setup();
    setup([row('ai')], { ai: invalid() });
    await form();
    vi.stubGlobal('confirm', () => true);
    routes['PUT config/ai'] = () => ({ body: null });
    await user.type(screen.getByLabelText('Nome'), 'ab');
    await user.click(saveButton());
    await waitFor(() => expect(puts().length).toBe(1));
    expect(puts()[0]?.body).toEqual({ name: 'ab' });
  });
});

describe('Config: carregando e erro', () => {
  it('não mostra o formulário enquanto a config não chegou', async () => {
    routes['GET plugins'] = () => ({ body: [row('ai')] });
    routes['GET config/ai'] = () => new Promise<Reply>(() => undefined);
    render(<Config />);
    await waitFor(() => expect(calls.some((c) => c.path === 'config/ai')).toBe(true));
    expect(screen.getByRole('heading', { level: 1, name: 'Config' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Salvar e recarregar' })).toBeNull();
  });

  it('falha ao listar plugins mostra o erro', async () => {
    routes['GET plugins'] = () => ({ status: 503, body: 'indisponível' });
    render(<Config />);
    expect((await screen.findByRole('alert')).textContent).toBe('503: indisponível');
  });

  it('falha ao carregar a config do plugin mostra o erro', async () => {
    routes['GET plugins'] = () => ({ body: [row('ai')] });
    routes['GET config/ai'] = () => ({ status: 500, body: 'falhou' });
    render(<Config />);
    expect((await screen.findByRole('alert')).textContent).toBe('500: falhou');
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('falha de rede vira "Falha de rede."', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    render(<Config />);
    expect((await screen.findByRole('alert')).textContent).toBe('Falha de rede.');
  });
});

describe('Config: lista de objetos', () => {
  const chain = (): ConfigResponse => ({
    schema: {
      type: 'object',
      properties: {
        models: {
          type: 'array',
          title: 'Modelos',
          items: {
            type: 'object',
            required: ['model'],
            properties: {
              model: { type: 'string', title: 'Modelo' },
              temperature: { type: 'number', title: 'Temperatura' },
            },
          },
        },
      },
    },
    view: {
      config: { models: [{ model: 'google:a', temperature: 1 }, { model: 'openai:b' }] },
      messages: {},
      sources: { models: 'override' },
    },
    secretsWritable: false,
  });

  it('reordena, edita, adiciona e remove itens; o PUT leva a ordem do editor', async () => {
    const user = userEvent.setup();
    setup([row('ai')], { ai: chain() });
    await form();
    routes['PUT config/ai'] = () => ({ body: null });
    expect((screen.getByLabelText('Modelos, item 1, Modelo') as HTMLInputElement).value).toBe(
      'google:a',
    );
    expect(
      (screen.getByRole('button', { name: 'Subir item 1 de Modelos' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Descer item 1 de Modelos' }));
    expect((screen.getByLabelText('Modelos, item 1, Modelo') as HTMLInputElement).value).toBe(
      'openai:b',
    );
    await user.type(screen.getByLabelText('Modelos, item 1, Temperatura'), '0.5');
    await user.click(screen.getByRole('button', { name: 'Adicionar item' }));
    await user.type(screen.getByLabelText('Modelos, item 3, Modelo'), 'anthropic:c');
    await user.click(screen.getByRole('button', { name: 'Remover item 2 de Modelos' }));
    await user.click(saveButton());
    await waitFor(() => expect(puts().length).toBe(1));
    expect(puts()[0]?.body).toEqual({
      models: [{ model: 'openai:b', temperature: 0.5 }, { model: 'anthropic:c' }],
    });
  });

  it('issue do servidor num item aparece junto da lista', async () => {
    const user = userEvent.setup();
    setup([row('ai')], { ai: chain() });
    await form();
    routes['PUT config/ai'] = () => ({
      status: 400,
      body: {
        error: 'invalid',
        issues: [{ path: 'models.0.model', message: 'use provider:modelo' }],
      },
    });
    await user.click(screen.getByRole('button', { name: 'Remover item 2 de Modelos' }));
    await user.click(saveButton());
    expect(
      (await screen.findByText('Item 1, Modelo: use provider:modelo')).getAttribute('role'),
    ).toBe('alert');
  });
});
