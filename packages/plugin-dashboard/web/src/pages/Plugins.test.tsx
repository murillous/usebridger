// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeResult, PluginRow } from '#web/lib/types.ts';
import { Plugins } from './Plugins.tsx';

// O `api` chama `fetch('api/<caminho>')`: cada teste responde por "<MÉTODO> <caminho>", sem servidor.
type Reply = { status?: number; body?: unknown };
let routes: Record<string, () => Reply>;
const calls: { path: string; method: string }[] = [];

beforeEach(() => {
  routes = {};
  calls.length = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = url.replace(/^api\//, '');
    const method = init?.method ?? 'GET';
    calls.push({ path, method });
    const reply = routes[`${method} ${path}`]?.() ?? { status: 404, body: 'sem rota' };
    const body = reply.body;
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status: reply.status ?? 200 });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BOOT = Date.UTC(2026, 0, 1, 12, 0, 0);
const loaded = (name: string, extra: Partial<PluginRow> = {}): PluginRow => ({
  name,
  version: '1.0.0',
  origin: `/plugins/${name}`,
  status: 'loaded',
  ...extra,
});
const skipped = (name: string, kind: string, extra: Record<string, unknown> = {}): PluginRow => ({
  name,
  version: '2.0.0',
  origin: `/plugins/${name}`,
  status: 'skipped',
  reason: { kind, ...extra },
});
const failed = (name: string, causeMessage = 'Error: boom'): PluginRow =>
  skipped(name, 'setup-failed', {
    causeMessage,
    error: { plugin: name, phase: 'setup', message: 'x' },
  });

const sample = (): PluginRow[] => [
  loaded('ok-plugin', {
    setupMs: 12,
    services: ['db'],
    contributions: ['dashboard.tabs'],
    contributionCounts: { 'dashboard.tabs': 5 },
    dependsOn: { base: '^1.0.0' },
  }),
  failed('quebrado'),
  skipped('filho', 'dependency-skipped', { dependency: 'quebrado' }),
  skipped('neto', 'dependency-skipped', { dependency: 'quebrado' }),
  skipped('velho', 'engine', { range: '>=9', coreVersion: '1.2.3' }),
  skipped('off', 'disabled'),
];

const show = (rows: PluginRow[] = sample(), boot: Reply = { body: { bootedAt: BOOT } }) => {
  routes['GET plugins'] = () => ({ body: rows });
  routes['GET plugins/boot'] = () => boot;
  render(<Plugins />);
};
// A linha aparece na tabela e na lista mobile (o CSS esconde uma): as consultas partem da tabela.
// O nome da linha começa pelo nome do plugin (primeira coluna).
const rowOf = (name: string) =>
  within(screen.getByRole('table')).getByRole('row', {
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} `),
  });
const switchOf = (name: string) =>
  within(rowOf(name)).getByRole('switch', { name: `Ativo: ${name}` });
const reloadOf = (name: string) =>
  within(rowOf(name)).getByRole('button', { name: `Recarregar ${name}` });
const posts = () => calls.filter((c) => c.method === 'POST').map((c) => c.path);
const result = (over: Partial<ChangeResult> = {}): ChangeResult => ({
  plugin: loaded('ok-plugin'),
  dependents: [],
  teardownErrors: [],
  ...over,
});

describe('Plugins: lista e estados', () => {
  it('mostra carregando e depois uma linha por plugin com o estado certo', async () => {
    show();
    expect(screen.getByText('Carregando…')).toBeTruthy();
    await screen.findByRole('table');
    expect(within(rowOf('ok-plugin')).getByText('carregado')).toBeTruthy();
    expect(within(rowOf('quebrado')).getByText('falhou')).toBeTruthy();
    expect(within(rowOf('filho')).getByText('pulado')).toBeTruthy();
    expect(within(rowOf('off')).getByText('desligado')).toBeTruthy();
  });

  it('desenha setup, dependências, serviços e contribuições do plugin carregado', async () => {
    show();
    await screen.findByRole('table');
    const cells = within(rowOf('ok-plugin'));
    expect(cells.getByText('OK · 12 ms')).toBeTruthy();
    expect(cells.getByText('base')).toBeTruthy();
    expect(cells.getByText('db')).toBeTruthy();
    expect(cells.getByText('dashboard.tabs ×5')).toBeTruthy();
  });

  it('subtítulo traz o horário do boot e o resumo', async () => {
    show();
    expect((await screen.findByText(/^Boot de /)).textContent).toMatch(
      /^Boot de \d\d:\d\d:\d\d · 1 carregado, 1 falhou, 3 pulados$/,
    );
  });

  it('sem o horário do boot (rota falha), o subtítulo segue só com o resumo', async () => {
    show(sample(), { status: 500 });
    expect((await screen.findByText('1 carregado, 1 falhou, 3 pulados')).textContent).toBe(
      '1 carregado, 1 falhou, 3 pulados',
    );
  });

  it('o chip explica o motivo do plugin pulado no title', async () => {
    show();
    await screen.findByRole('table');
    const titles = screen.getAllByText('pulado').map((chip) => chip.title);
    expect(titles).toContain('Dependência ignorada: quebrado');
    expect(titles).toContain('Exige core >=9 (atual 1.2.3)');
  });
});

describe('Plugins: busca e filtros', () => {
  it('conta cada filtro e filtra a tabela', async () => {
    show();
    await screen.findByRole('table');
    expect(screen.getByRole('button', { name: 'Todos 6' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Com problema 4' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Desligados 1' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Desligados 1' }));
    const table = screen.getByRole('table');
    expect(within(table).getByText('off')).toBeTruthy();
    expect(within(table).queryByText('ok-plugin')).toBeNull();
    expect(screen.getByRole('button', { name: 'Desligados 1' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Com problema 4' }));
    expect(within(screen.getByRole('table')).queryByText('off')).toBeNull();
    expect(within(screen.getByRole('table')).getByText('velho')).toBeTruthy();
  });

  it('busca por nome sem diferenciar maiúsculas e avisa quando nada casa', async () => {
    show();
    await screen.findByRole('table');
    const box = screen.getByRole('searchbox', { name: 'Buscar plugin' });
    await userEvent.type(box, '  OK-PL');
    const table = screen.getByRole('table');
    expect(within(table).getByText('ok-plugin')).toBeTruthy();
    expect(within(table).queryByText('quebrado')).toBeNull();
    await userEvent.type(box, 'zzz');
    expect(screen.getByText('Nenhum plugin encontrado.')).toBeTruthy();
  });
});

describe('Plugins: ativar, desativar e recarregar', () => {
  it('ligar plugin desligado chama enable, mostra o resultado e recarrega a lista', async () => {
    show();
    routes['POST plugins/off/enable'] = () => ({ body: result({ plugin: loaded('off') }) });
    await screen.findByRole('table');
    expect(switchOf('off').getAttribute('aria-checked')).toBe('false');
    await userEvent.click(switchOf('off'));
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('off: enable concluído (ativo).');
    expect(posts()).toEqual(['plugins/off/enable']);
    expect(calls.filter((c) => c.path === 'plugins')).toHaveLength(2);
  });

  it('desativar pede confirmação e, aceita, chama disable', async () => {
    show();
    routes['POST plugins/ok-plugin/disable'] = () => ({
      body: result({ plugin: skipped('ok-plugin', 'disabled') }),
    });
    await screen.findByRole('table');
    expect(switchOf('ok-plugin').getAttribute('aria-checked')).toBe('true');
    await userEvent.click(switchOf('ok-plugin'));
    const dialog = screen.getByRole('alertdialog', { name: 'Desativar ok-plugin?' });
    expect(posts()).toEqual([]);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Desativar' }));
    expect((await screen.findByRole('status')).textContent).toContain(
      'disable concluído (ignorado).',
    );
    expect(posts()).toEqual(['plugins/ok-plugin/disable']);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Cancelar e Escape fecham sem chamar o servidor e devolvem o foco ao switch', async () => {
    show();
    await screen.findByRole('table');
    await userEvent.click(switchOf('ok-plugin'));
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(switchOf('ok-plugin'));
    await userEvent.click(switchOf('ok-plugin'));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('plugin carregado tem Recarregar (o pulado não) e chama reload', async () => {
    show();
    routes['POST plugins/ok-plugin/reload'] = () => ({ body: result() });
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Recarregar off' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recarregar quebrado' })).toBeNull();
    await userEvent.click(reloadOf('ok-plugin'));
    expect((await screen.findByRole('status')).textContent).toContain(
      'ok-plugin: reload concluído (ativo).',
    );
    expect(posts()).toEqual(['plugins/ok-plugin/reload']);
  });

  it('o nome vai codificado na rota', async () => {
    show([loaded('@lumabot/a b')]);
    routes['POST plugins/%40lumabot%2Fa%20b/reload'] = () => ({ body: result() });
    await screen.findByRole('table');
    await userEvent.click(reloadOf('@lumabot/a b'));
    await screen.findByRole('status');
    expect(posts()).toEqual(['plugins/%40lumabot%2Fa%20b/reload']);
  });
});

describe('Plugins: resultado da cascata', () => {
  it('lista dependentes afetados e erros de teardown', async () => {
    show();
    routes['POST plugins/ok-plugin/reload'] = () => ({
      body: result({
        dependents: [loaded('filho'), skipped('neto', 'dependency-skipped')],
        teardownErrors: [
          { plugin: 'filho', phase: 'teardown', message: 'travou', timedOut: true },
          { plugin: 'neto', phase: 'dispose', message: 'falhou', timedOut: false },
        ],
      }),
    });
    await screen.findByRole('table');
    await userEvent.click(reloadOf('ok-plugin'));
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Dependentes afetados: filho (ativo), neto (ignorado)');
    expect(status.textContent).toContain(
      'Erro no teardown de filho (teardown, tempo esgotado): travou',
    );
    expect(status.textContent).toContain('Erro no teardown de neto (dispose): falhou');
  });

  it('o aviso recebe o foco', async () => {
    show();
    routes['POST plugins/off/enable'] = () => ({ body: result({ plugin: loaded('off') }) });
    await screen.findByRole('table');
    await userEvent.click(switchOf('off'));
    const status = await screen.findByRole('status');
    await vi.waitFor(() => expect(document.activeElement).toBe(status));
  });
});

describe('Plugins: card de problema', () => {
  it('mostra a causa do setup, os dependentes pulados e recarrega pelo botão', async () => {
    show();
    routes['POST plugins/quebrado/reload'] = () => ({
      body: result({ plugin: loaded('quebrado') }),
    });
    const card = await screen.findByRole('region', { name: 'quebrado falhou' });
    expect(within(card).getByText('Error: boom')).toBeTruthy();
    expect(card.textContent).toContain(
      'Os dependentes filho, neto foram pulados (dependency-skipped).',
    );
    expect(within(card).getByRole('link', { name: 'Abrir config' }).getAttribute('href')).toBe(
      '#/config/quebrado',
    );
    await userEvent.click(within(card).getByRole('button', { name: 'Recarregar plugin' }));
    await screen.findByRole('status');
    expect(posts()).toEqual(['plugins/quebrado/reload']);
  });

  it('usa o singular com um dependente e cai na mensagem do erro, depois no texto padrão', async () => {
    show([
      skipped('a', 'setup-failed'),
      skipped('b', 'setup-failed', { error: { plugin: 'b', phase: 'setup', message: 'do erro' } }),
      skipped('c', 'dependency-skipped', { dependency: 'a' }),
    ]);
    const a = await screen.findByRole('region', { name: 'a falhou' });
    expect(within(a).getByText('Falha no setup.')).toBeTruthy();
    expect(a.textContent).toContain('O dependente c foi pulado (dependency-skipped).');
    const b = screen.getByRole('region', { name: 'b falhou' });
    expect(within(b).getByText('do erro')).toBeTruthy();
  });

  it('sem plugin que falhou, não há card', async () => {
    show([loaded('ok-plugin')]);
    await screen.findByRole('table');
    expect(screen.queryByRole('region')).toBeNull();
  });
});

describe('Plugins: erros', () => {
  it('lista que falha com 500 mostra o alerta e some o "Carregando"', async () => {
    routes['GET plugins'] = () => ({ status: 500, body: 'quebrou' });
    render(<Plugins />);
    expect((await screen.findByRole('alert')).textContent).toBe('500: quebrou');
    expect(screen.queryByText('Carregando…')).toBeNull();
  });

  it('falha de rede vira "Falha de rede."', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    render(<Plugins />);
    expect((await screen.findByRole('alert')).textContent).toBe('Falha de rede.');
  });

  it('409 na ação não mostra o resultado e recarrega a lista', async () => {
    show();
    routes['POST plugins/ok-plugin/reload'] = () => ({ status: 409, body: 'em andamento' });
    await screen.findByRole('table');
    await userEvent.click(reloadOf('ok-plugin'));
    // load() roda no finally: lista inicial + depois da ação.
    await vi.waitFor(() => expect(calls.filter((c) => c.path === 'plugins')).toHaveLength(2));
    expect(posts()).toEqual(['plugins/ok-plugin/reload']);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('falha da lista depois da ação mostra o erro da lista', async () => {
    show();
    routes['POST plugins/ok-plugin/reload'] = () => {
      routes['GET plugins'] = () => ({ status: 500, body: 'fora do ar' });
      return { body: result() };
    };
    await screen.findByRole('table');
    await userEvent.click(reloadOf('ok-plugin'));
    expect((await screen.findByRole('alert')).textContent).toBe('500: fora do ar');
  });

  // Bug #204: o load() do finally limpa o erro da ação. Vira it quando for corrigido.
  it('409 na ação mantém o alerta "409: <mensagem>" visível depois de recarregar a lista', async () => {
    show();
    routes['POST plugins/ok-plugin/reload'] = () => ({ status: 409, body: 'em andamento' });
    await screen.findByRole('table');
    await userEvent.click(reloadOf('ok-plugin'));
    await vi.waitFor(() => expect(calls.filter((c) => c.path === 'plugins')).toHaveLength(2));
    expect((await screen.findByRole('alert')).textContent).toBe('409: em andamento');
  });
});

describe('Plugins: dependências opcionais (#195)', () => {
  it('"Depende de" mostra obrigatórias e opcionais com "?" na tabela e na lista mobile', async () => {
    show([loaded('x', { dependsOn: { a: '*' }, optionalDependsOn: { metrics: '*' } })]);
    await screen.findByRole('table');
    expect(within(rowOf('x')).getByText('a, metrics?')).toBeTruthy();
    const item = document.querySelector('.plist li');
    expect(item?.textContent).toContain('depende de a, metrics?');
  });
});
