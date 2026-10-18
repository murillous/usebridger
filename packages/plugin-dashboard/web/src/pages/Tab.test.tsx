// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabView } from '#web/lib/types.ts';
import { Tab } from './Tab.tsx';

// O `api` chama `fetch('api/<caminho>')`: cada teste responde por caminho, sem servidor.
type Reply = { status?: number; body?: unknown };
let routes: Record<string, (init?: RequestInit) => Reply>;
const calls: { path: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  routes = {};
  calls.length = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = url.replace(/^api\//, '');
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const reply = routes[`${method} ${path}`]?.(init) ?? { status: 404, body: 'sem rota' };
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
  vi.restoreAllMocks();
});

const W = 'tabs/reminders/lembretes';
const tab = (widgets: TabView['widgets']): TabView => ({
  key: 'reminders/lembretes',
  plugin: 'reminders',
  id: 'lembretes',
  title: 'Lembretes',
  order: 0,
  widgets,
});
const show = (view: TabView, refresh = vi.fn()) => {
  render(<Tab tabs={[view]} tabKey={view.key} refresh={refresh} />);
  return refresh;
};

describe('Tab: cabeçalho e estados da aba', () => {
  it('mostra título, dono e "não disponível" quando a aba sumiu', () => {
    show(tab([]));
    expect(screen.getByRole('heading', { level: 1, name: 'Lembretes' })).toBeTruthy();
    expect(screen.getByText('reminders')).toBeTruthy();
    cleanup();
    render(<Tab tabs={[]} tabKey="reminders/lembretes" refresh={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('não está mais disponível');
  });

  it('carregando enquanto o manifesto não chegou', () => {
    render(<Tab tabs={undefined} tabKey="x/y" refresh={vi.fn()} />);
    expect(screen.getByText('Carregando…')).toBeTruthy();
  });
});

describe('Tab: título por widget (ADR 0118)', () => {
  it('desenha h3 e rotula a seção com o title; sem title, a seção usa o id', async () => {
    routes[`GET ${W}/lista`] = () => ({ body: { rows: [] } });
    show(
      tab([
        {
          kind: 'table',
          id: 'lista',
          title: 'Próximos',
          columns: [{ key: 'a', label: 'A' }],
          actions: [],
        },
        { kind: 'text', id: 'ajuda', markdown: 'Use !lembrar' },
        { kind: 'text', id: 'vazio', title: '', markdown: 'x' },
      ]),
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Próximos' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Próximos' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'ajuda' })).toBeTruthy();
    // Título vazio: sem h2 e a seção rotulada pelo id, não por texto vazio.
    expect(screen.getByRole('region', { name: 'vazio' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    await screen.findByText('Nada por aqui.');
  });

  it('series põe o título no cartão, uma vez só, e cai em "Série" sem ele', async () => {
    routes[`GET ${W}/envios?days=30`] = () => ({ body: [{ label: 'd1', value: 2 }] });
    routes[`GET ${W}/outra?days=30`] = () => ({ body: [] });
    show(
      tab([
        { kind: 'series', id: 'envios', title: 'Envios' },
        { kind: 'series', id: 'outra' },
      ]),
    );
    expect(screen.getAllByRole('heading', { name: 'Envios' })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Série' })).toBeTruthy();
    expect((await screen.findByRole('img', { name: /^Envios: 1 pontos/ })).tagName).toBe('svg');
    expect(await screen.findByRole('img', { name: 'Série: sem dados' })).toBeTruthy();
  });

  it('series troca o período pela query days', async () => {
    routes[`GET ${W}/envios?days=30`] = () => ({ body: [] });
    routes[`GET ${W}/envios?days=7`] = () => ({ body: [{ label: 'd7', value: 1 }] });
    show(tab([{ kind: 'series', id: 'envios', title: 'Envios' }]));
    await userEvent.selectOptions(screen.getByLabelText('Período de Envios'), '7');
    expect(await screen.findByRole('img', { name: /de d7 a d7/ })).toBeTruthy();
  });
});

describe('Tab: stats', () => {
  it('aplica o tom no cartão e deixa neutro o item sem tom', async () => {
    routes[`GET ${W}/resumo`] = () => ({
      body: [
        { label: 'Atrasados', value: 1, tone: 'warn' },
        { label: 'Pendentes', value: 2, hint: 'hoje' },
      ],
    });
    show(tab([{ kind: 'stats', id: 'resumo' }]));
    const late = (await screen.findByText('Atrasados')).closest('.stat');
    const pending = screen.getByText('Pendentes').closest('.stat');
    expect(late?.classList.contains('warn')).toBe(true);
    expect(pending?.className).not.toMatch(/\b(ok|warn|danger)\b/);
    expect(screen.getByText('hoje')).toBeTruthy();
  });

  it('erro 500 fica no widget, com mensagem genérica e "Tentar de novo"', async () => {
    let fail = true;
    routes[`GET ${W}/resumo`] = () =>
      fail ? { status: 500, body: 'segredo' } : { body: [{ label: 'Ok', value: 1 }] };
    show(tab([{ kind: 'stats', id: 'resumo' }]));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Erro ao carregar este widget.');
    expect(alert.textContent).not.toContain('segredo');
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Ok')).toBeTruthy();
  });

  it('404 no load avisa a aba (sumiu) pelo refresh', async () => {
    const refresh = show(tab([{ kind: 'stats', id: 'resumo' }]));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

describe('Tab: table', () => {
  const lista = {
    kind: 'table' as const,
    id: 'lista',
    columns: [
      { key: 'texto', label: 'Texto' },
      { key: 'quando', label: 'Quando' },
    ],
    actions: [{ id: 'cancelar', label: 'Cancelar', confirm: true }],
  };

  it('lista as linhas e roda a ação confirmada com a linha, recarregando depois', async () => {
    let rows = [{ id: 'r1', texto: 'Pagar conta', quando: 'amanhã' }];
    routes[`GET ${W}/lista`] = () => ({ body: { rows } });
    routes[`POST ${W}/lista/actions/cancelar`] = () => {
      rows = [];
      return { status: 204 };
    };
    vi.stubGlobal('confirm', () => true);
    show(tab([lista]));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Pagar conta')).toBeTruthy();
    await userEvent.click(within(table).getByRole('button', { name: 'Cancelar' }));
    expect(await screen.findByText('Nada por aqui.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      row: { id: 'r1', texto: 'Pagar conta', quando: 'amanhã' },
    });
  });

  it('ação recusada no confirm não chama o servidor', async () => {
    routes[`GET ${W}/lista`] = () => ({ body: { rows: [{ id: 'r1', texto: 'x', quando: 'y' }] } });
    vi.stubGlobal('confirm', () => false);
    show(tab([lista]));
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('button', { name: 'Cancelar' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('ação que falha mostra o erro sem tirar a tabela', async () => {
    routes[`GET ${W}/lista`] = () => ({ body: { rows: [{ id: 'r1', texto: 'x', quando: 'y' }] } });
    routes[`POST ${W}/lista/actions/cancelar`] = () => ({ status: 500 });
    vi.stubGlobal('confirm', () => true);
    show(tab([lista]));
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('button', { name: 'Cancelar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Erro ao carregar este widget.');
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('"Carregar mais" pede o cursor e junta as páginas', async () => {
    routes[`GET ${W}/lista`] = () => ({
      body: { rows: [{ id: 'r1', texto: 'um' }], cursor: 'c2' },
    });
    routes[`GET ${W}/lista?cursor=c2`] = () => ({ body: { rows: [{ id: 'r2', texto: 'dois' }] } });
    show(tab([{ ...lista, actions: [] }]));
    await userEvent.click(await screen.findByRole('button', { name: 'Carregar mais' }));
    const table = screen.getByRole('table');
    expect(await within(table).findByText('dois')).toBeTruthy();
    expect(within(table).getByText('um')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
  });
});

describe('Tab: form', () => {
  const schema = {
    type: 'object',
    properties: { texto: { type: 'string', title: 'Texto' } },
    required: ['texto'],
  };

  it('usa o submitLabel no botão (ADR 0118) e "Enviar" sem ele', () => {
    show(
      tab([
        { kind: 'form', id: 'novo', title: 'Novo lembrete global', submitLabel: 'Agendar', schema },
        { kind: 'form', id: 'outro', schema },
      ]),
    );
    expect(screen.getByRole('button', { name: 'Agendar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Novo lembrete global' })).toBeTruthy();
  });

  it('envia os campos, confirma e limpa o formulário', async () => {
    routes[`POST ${W}/novo/submit`] = () => ({ status: 204 });
    show(tab([{ kind: 'form', id: 'novo', submitLabel: 'Agendar', schema }]));
    await userEvent.type(screen.getByLabelText(/Texto/), 'Pagar conta');
    await userEvent.click(screen.getByRole('button', { name: 'Agendar' }));
    expect((await screen.findByRole('status')).textContent).toBe('Enviado.');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ texto: 'Pagar conta' });
    expect((screen.getByLabelText(/Texto/) as HTMLInputElement).value).toBe('');
  });

  it('400 mostra as issues do Zod junto do campo', async () => {
    routes[`POST ${W}/novo/submit`] = () => ({
      status: 400,
      body: { error: 'invalid', issues: [{ path: 'texto', message: 'curto demais' }] },
    });
    show(tab([{ kind: 'form', id: 'novo', schema }]));
    await userEvent.type(screen.getByLabelText(/Texto/), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    // Dois alertas: o aviso geral do form e o erro do campo.
    expect(await screen.findByText(/Dados recusados/)).toBeTruthy();
    expect(screen.getByText('curto demais')).toBeTruthy();
  });
});
