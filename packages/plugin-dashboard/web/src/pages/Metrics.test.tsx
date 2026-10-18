// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetricRowView, MetricsResponse } from '#web/lib/types.ts';
import { Metrics } from './Metrics.tsx';

// O `api` chama `fetch('api/<caminho>')`: cada teste responde por "<MÉTODO> <caminho>", sem servidor.
type Reply = { status?: number; body?: unknown };
let routes: Record<string, () => Reply>;
const paths: string[] = [];

beforeEach(() => {
  routes = {};
  paths.length = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = url.replace(/^api\//, '');
    paths.push(path);
    const reply = routes[`${init?.method ?? 'GET'} ${path}`]?.() ?? {
      status: 404,
      body: 'sem rota',
    };
    const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return new Response(body, { status: reply.status ?? 200 });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const D1 = '2026-10-16';
const D2 = '2026-10-17';
const D3 = '2026-10-18';
// 12 limites + o balde `+Inf`; o índice 4 é o limite de 100 ms.
const buckets = (at: number): number[] => Array.from({ length: 13 }, (_, i) => (i === at ? 1 : 0));
const counter = (day: string, labels: Record<string, string>, value: number): MetricRowView => ({
  type: 'counter',
  day,
  labels,
  value,
});
const gauge = (day: string, max: number): MetricRowView => ({
  type: 'gauge',
  day,
  labels: {},
  last: max,
  max,
});
const histogram = (day: string, route: string, at: number): MetricRowView => ({
  type: 'histogram',
  day,
  labels: { route },
  count: 1,
  sum: 1,
  buckets: buckets(at),
});

const full: MetricsResponse = {
  available: true,
  from: D1,
  to: D3,
  metrics: [
    {
      name: 'bridger.messages.handled',
      plugin: 'core',
      rows: [
        counter(D2, { status: 'ok' }, 10),
        counter(D3, { status: 'ok' }, 5),
        counter(D3, { status: 'error' }, 2),
      ],
    },
    {
      name: 'bridger.messages.handle_duration_ms',
      plugin: 'core',
      // Ontem 100 ms; hoje cai no balde `+Inf` (índice 12), sem teto para mostrar.
      rows: [histogram(D2, '/start', 4), histogram(D3, '/slow', 12)],
    },
    { name: 'bridger.outbound.pending', plugin: 'core', rows: [gauge(D2, 4), gauge(D3, 9)] },
    {
      name: 'acme.pedidos',
      plugin: 'acme',
      rows: [counter(D3, { loja: 'a' }, 3), counter(D3, { loja: 'b' }, 4)],
    },
    { name: 'orfa.total', rows: [counter(D3, {}, 1)] },
  ],
};

const serve = (body: unknown, days = 7) => {
  routes[`GET metrics?days=${days}`] = () => ({ body });
};
const panel = (name: string) => screen.findByRole('region', { name });
const catalogRows = async () => {
  const section = await screen.findByRole('region', { name: 'Todas as métricas registradas' });
  return (name: string) =>
    within(within(section).getByRole('table')).getByRole('row', { name: new RegExp(name) });
};

describe('Metrics: estados da tela', () => {
  it('mostra "Carregando" até a resposta chegar', async () => {
    serve(full);
    render(<Metrics />);
    expect(screen.getByText('Carregando…')).toBeTruthy();
    await panel('Fila de saída');
    expect(screen.queryByText('Carregando…')).toBeNull();
  });

  it('mostra o alerta de erro quando a chamada falha', async () => {
    routes['GET metrics?days=7'] = () => ({ status: 500, body: 'erro interno' });
    render(<Metrics />);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Não foi possível ler as métricas',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Métricas' })).toBeTruthy();
  });

  it('plugin de métricas ausente: explica como instalar', async () => {
    serve({ available: false });
    render(<Metrics />);
    expect(
      await screen.findByRole('heading', { name: 'Plugin de métricas não carregado' }),
    ).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('plugin de métricas antigo (reason version): pede atualização', async () => {
    serve({ available: false, reason: 'version' });
    render(<Metrics />);
    expect(
      await screen.findByRole('heading', { name: 'Atualize o plugin de métricas' }),
    ).toBeTruthy();
  });

  it('sem métrica com dados: tabela vazia em texto', async () => {
    serve({ available: true, from: D1, to: D3, metrics: [{ name: 'x.vazia', rows: [] }] });
    render(<Metrics />);
    expect(await screen.findByText('Nenhuma métrica com dados no período.')).toBeTruthy();
    const section = screen.getByRole('region', { name: 'Todas as métricas registradas' });
    expect(within(section).queryByRole('table')).toBeNull();
  });
});

describe('Metrics: período', () => {
  it('começa em 7 dias e refaz a chamada ao trocar o período', async () => {
    serve(full);
    serve({ ...full, from: '2026-09-19' }, 30);
    const user = userEvent.setup();
    render(<Metrics />);
    await panel('Fila de saída');
    expect(screen.getByRole('button', { name: '7 dias' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    await user.click(screen.getByRole('button', { name: '30 dias' }));
    await waitFor(() => expect(paths).toContain('metrics?days=30'));
    expect(screen.getByRole('button', { name: '30 dias' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: '7 dias' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    // O cabeçalho da coluna acompanha o número de dias do intervalo devolvido.
    expect(await screen.findByRole('columnheader', { name: '30 dias' })).toBeTruthy();
  });
});

describe('useMetrics: resposta atrasada', () => {
  it('ignora a resposta de 7 dias que chega depois da troca para 30', async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const reply = (body: unknown) => new Response(JSON.stringify(body));
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === 'api/metrics?days=7') {
        await gate;
        return reply({ ...full, metrics: [{ name: 'velha.sete', rows: [counter(D3, {}, 1)] }] });
      }
      return reply({ ...full, metrics: [{ name: 'nova.trinta', rows: [counter(D3, {}, 1)] }] });
    });
    const user = userEvent.setup();
    render(<Metrics />);
    await user.click(screen.getByRole('button', { name: '30 dias' }));
    expect(await screen.findByRole('cell', { name: /nova\.trinta/ })).toBeTruthy();
    release();
    // Dá a chance de a resposta velha ser aplicada; a guarda `alive` deve descartá-la.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('cell', { name: /velha\.sete/ })).toBeNull();
    expect(screen.getByRole('cell', { name: /nova\.trinta/ })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '3 dias' })).toBeTruthy();
  });
});

describe('Metrics: painéis do kernel', () => {
  it('mensagens por dia: soma de hoje e gráfico acessível', async () => {
    serve(full);
    render(<Metrics />);
    const p = within(await panel('Mensagens por dia'));
    expect(p.getByText('7')).toBeTruthy();
    expect(
      p.getByRole('img', {
        name: `Mensagens tratadas por dia: ${D1} 0; ${D2} 10; ${D3} 7`,
      }),
    ).toBeTruthy();
  });

  it('fila de saída: máximo do dia, não a soma', async () => {
    serve(full);
    render(<Metrics />);
    const p = within(await panel('Fila de saída'));
    expect(p.getByText('máx 9')).toBeTruthy();
    expect(
      p.getByRole('img', {
        name: `Fila de saída, máximo de itens pendentes por dia: ${D1} 0; ${D2} 4; ${D3} 9`,
      }),
    ).toBeTruthy();
  });

  it('latência: balde +Inf vira "> 30.000 ms" e dia sem dado vira "sem dado"', async () => {
    serve(full);
    render(<Metrics />);
    const p = within(await panel('Latência p95'));
    expect(p.getByText('> 30.000 ms', { selector: 'div' })).toBeTruthy();
    expect(
      p.getByRole('img', {
        name: `Latência p95 por dia, em milissegundos: ${D1} sem dado; ${D2} 100 ms; ${D3} > 30.000 ms`,
      }),
    ).toBeTruthy();
  });

  it('usuários ativos: valor de hoje e grupos ativos', async () => {
    serve({
      ...full,
      metrics: [
        { name: 'bridger.active.users', plugin: 'core', rows: [counter(D3, {}, 12)] },
        { name: 'bridger.active.groups', plugin: 'core', rows: [counter(D3, {}, 3)] },
      ],
    });
    render(<Metrics />);
    const p = within(await panel('Usuários ativos por dia'));
    expect(p.getByText('12')).toBeTruthy();
    expect(p.getByText(/Grupos ativos hoje/).textContent).toBe('Grupos ativos hoje: 3');
  });

  it('sem dados do kernel: painéis zerados, com gráficos', async () => {
    serve({ available: true, from: D1, to: D3, metrics: [] });
    render(<Metrics />);
    const p = within(await panel('Fila de saída'));
    expect(p.getByText('máx 0')).toBeTruthy();
    expect(screen.getAllByRole('img')).toHaveLength(4);
  });
});

describe('Metrics: tabela de todas as métricas', () => {
  it('lista nome com contagem de séries, dono, tipo e rótulos', async () => {
    serve(full);
    render(<Metrics />);
    const row = within((await catalogRows())('acme.pedidos'));
    expect(row.getByRole('cell', { name: 'acme.pedidos · 2 séries' })).toBeTruthy();
    expect(row.getByRole('cell', { name: 'acme' })).toBeTruthy();
    expect(row.getByText('counter')).toBeTruthy();
    expect(row.getByRole('cell', { name: 'loja' })).toBeTruthy();
  });

  it('dono "core" para o kernel e "-" quando a métrica não tem dono', async () => {
    serve(full);
    render(<Metrics />);
    const row = await catalogRows();
    expect(
      within(row('bridger.messages.handled')).getByRole('cell', { name: 'core' }),
    ).toBeTruthy();
    // "-" aparece no dono e nos rótulos vazios da métrica sem dono.
    expect(within(row('orfa.total')).getAllByRole('cell', { name: '-' })).toHaveLength(2);
  });

  it('formata por tipo: soma, p95 do histograma e máximo do gauge', async () => {
    serve(full);
    render(<Metrics />);
    const row = await catalogRows();
    const handled = within(row('bridger.messages.handled'));
    expect(handled.getByRole('cell', { name: '7' })).toBeTruthy();
    expect(handled.getByRole('cell', { name: '17' })).toBeTruthy();
    const lat = within(row('handle_duration_ms'));
    expect(lat.getAllByRole('cell', { name: 'p95 > 30.000 ms' })).toHaveLength(2);
    const pending = within(row('outbound.pending'));
    expect(pending.getAllByRole('cell', { name: 'máx 9' })).toHaveLength(2);
  });
});

describe('Metrics: copiar URL do scrape', () => {
  // `userEvent.setup()` instala o próprio `navigator.clipboard`; o espião vem depois dele.
  it('copia a URL e avisa por aria-live', async () => {
    serve(full);
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    render(<Metrics />);
    await user.click(await screen.findByRole('button', { name: 'Copiar URL do scrape' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/metrics\/metrics$/));
    expect(await screen.findByText('URL copiada')).toBeTruthy();
  });

  it('sem permissão da área de transferência: mostra a URL no botão', async () => {
    serve(full);
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('negado'));
    render(<Metrics />);
    await user.click(await screen.findByRole('button', { name: 'Copiar URL do scrape' }));
    const btn = await screen.findByRole('button', { name: /\/metrics\/metrics$/ });
    expect(btn.textContent).toMatch(/^https?:/);
  });
});
