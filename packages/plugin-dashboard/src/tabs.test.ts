import { createHttp, definePlugin, secret } from '@usebridger/core';
import { z } from '@usebridger/core/zod';
import { createTestBot } from '@usebridger/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { dashboard } from './index.ts';
import type { DashboardTab } from './tabs.ts';

const TOKEN = 'segredo-do-painel';
const bots: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop();
});

const cancelled: string[] = [];
const submitted: unknown[] = [];

const lembretes: DashboardTab = {
  id: 'lembretes',
  title: 'Lembretes',
  order: 2,
  widgets: [
    { kind: 'stats', id: 'resumo', load: async () => [{ label: 'Pendentes', value: 2 }] },
    {
      kind: 'table',
      id: 'lista',
      columns: [
        { key: 'texto', label: 'Texto' },
        { key: 'quando', label: 'Quando' },
      ],
      load: async ({ cursor }) => ({
        rows: [{ id: cursor ?? 'r1', texto: 'Pagar conta', quando: 'amanhã' }],
      }),
      actions: [
        {
          id: 'cancelar',
          label: 'Cancelar',
          confirm: true,
          run: async ({ row }) => {
            cancelled.push(row.id);
          },
        },
        {
          id: 'quebra',
          label: 'Quebra',
          run: async () => {
            throw new Error('segredo-interno');
          },
        },
      ],
    },
    {
      kind: 'series',
      id: 'envios',
      load: async ({ days }) => [{ label: `d${days}`, value: 1 }],
    },
    {
      kind: 'form',
      id: 'novo',
      schema: z.object({ texto: z.string().min(3), minutos: z.number().int().min(1) }),
      submit: async (input) => {
        submitted.push(input);
      },
    },
    { kind: 'text', id: 'ajuda', markdown: 'Use `!lembrar`.' },
    {
      kind: 'table',
      id: 'quebrado',
      columns: [{ key: 'a', label: 'A' }],
      load: async () => {
        throw new Error('segredo-interno');
      },
    },
  ],
};

// Plugin de exemplo: contribui a aba sem tocar no código do dashboard.
const reminders = definePlugin({
  name: 'reminders',
  version: '1.0.0',
  engine: '<1.0.0',
  after: ['dashboard'],
  setup(ctx) {
    ctx.services.contribute('dashboard.tabs', lembretes);
  },
});

// Mesmo `id` em outro plugin, id repetido no mesmo plugin, id inválido e kind de dashboard futuro.
const outro = definePlugin({
  name: 'outro',
  version: '1.0.0',
  engine: '<1.0.0',
  after: ['dashboard'],
  setup(ctx) {
    ctx.services.contribute('dashboard.tabs', {
      id: 'lembretes',
      title: 'Outro',
      order: 1,
      widgets: [{ kind: 'text', id: 'a', markdown: 'x' }],
    });
    ctx.services.contribute('dashboard.tabs', { id: 'lembretes', title: 'Dup', widgets: [] });
    ctx.services.contribute('dashboard.tabs', { id: 'Inválido', title: 'X', widgets: [] });
    ctx.services.contribute('dashboard.tabs', {
      id: 'misto',
      title: 'Misto',
      widgets: [{ kind: 'futuro', id: 'z' } as never, { kind: 'text', id: 'ok', markdown: 'ok' }],
    });
  },
});

async function start() {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const bot = await createTestBot({
    plugins: [dashboard, reminders, outro],
    http,
    logLevel: 'info',
    adminPlugins: ['dashboard'],
    pluginConfig: { dashboard: { token: TOKEN } },
  });
  bots.push(bot);
  const url = `http://127.0.0.1:${http.port}/plugins/dashboard`;
  const login = await fetch(`${url}/api/login`, {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const get = (path: string) => fetch(`${url}${path}`, { headers: { cookie } });
  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { url, get, post };
}

const W = '/api/tabs/reminders/lembretes';

describe('abas de plugins (dashboard.tabs)', () => {
  it('manifesto: chave plugin/id com o dono do registry, ordem, sem funções, e exige sessão', async () => {
    const { url, get } = await start();
    expect((await fetch(`${url}/api/tabs`)).status).toBe(401);
    const tabs = (await (await get('/api/tabs')).json()) as {
      key: string;
      widgets: { kind: string; schema?: { properties: object }; actions?: unknown[] }[];
    }[];
    // misto sem order (0), depois order 1 e 2; id repetido e inválido ficam de fora.
    expect(tabs.map((t) => t.key)).toEqual([
      'outro/misto',
      'outro/lembretes',
      'reminders/lembretes',
    ]);
    const mine = tabs.find((t) => t.key === 'reminders/lembretes');
    expect(mine?.widgets.map((w) => w.kind)).toEqual([
      'stats',
      'table',
      'series',
      'form',
      'text',
      'table',
    ]);
    expect(mine?.widgets[3]?.schema?.properties).toHaveProperty('texto');
    expect(mine?.widgets[1]?.actions).toEqual([
      { id: 'cancelar', label: 'Cancelar', confirm: true },
      { id: 'quebra', label: 'Quebra', confirm: false },
    ]);
    // kind desconhecido é ignorado, o resto da aba fica.
    expect(tabs.find((t) => t.key === 'outro/misto')?.widgets.map((w) => w.kind)).toEqual(['text']);
  });

  it('load roda por widget, com cursor e days da query', async () => {
    const { get } = await start();
    expect(await (await get(`${W}/resumo`)).json()).toEqual([{ label: 'Pendentes', value: 2 }]);
    expect(await (await get(`${W}/lista?cursor=r9`)).json()).toMatchObject({
      rows: [{ id: 'r9' }],
    });
    expect(await (await get(`${W}/envios?days=7`)).json()).toEqual([{ label: 'd7', value: 1 }]);
    expect(await (await get(`${W}/envios?days=abc`)).json()).toEqual([{ label: 'd30', value: 1 }]);
    expect((await get(`${W}/ajuda`)).status).toBe(404);
  });

  it('erro de load vira 500 genérico só daquele widget', async () => {
    const { get } = await start();
    const res = await get(`${W}/quebrado`);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('segredo-interno');
    expect((await get(`${W}/resumo`)).status).toBe(200);
  });

  it('ação de linha roda o run; erro vira 500; ação, linha ou origem inválida recusada', async () => {
    const { post } = await start();
    expect((await post(`${W}/lista/actions/cancelar`, { row: { id: 'r1' } })).status).toBe(204);
    expect(cancelled).toEqual(['r1']);
    const bad = await post(`${W}/lista/actions/quebra`, { row: { id: 'r1' } });
    expect(bad.status).toBe(500);
    expect(await bad.text()).not.toContain('segredo-interno');
    expect((await post(`${W}/lista/actions/nada`, { row: { id: 'r1' } })).status).toBe(404);
    expect((await post(`${W}/lista/actions/cancelar`, { row: {} })).status).toBe(400);
    const evil = await post(
      `${W}/lista/actions/cancelar`,
      { row: { id: 'r1' } },
      { origin: 'http://evil.test' },
    );
    expect(evil.status).toBe(403);
  });

  it('submit valida com o Zod: inválido devolve as issues, válido roda o submit', async () => {
    const { post } = await start();
    const res = await post(`${W}/novo/submit`, { texto: 'a', minutos: 0 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: { path: string; message: string }[] };
    expect(body.issues.map((i) => i.path).sort()).toEqual(['minutos', 'texto']);
    expect(submitted).toEqual([]);
    expect((await post(`${W}/novo/submit`, { texto: 'abc', minutos: 5 })).status).toBe(204);
    expect(submitted).toEqual([{ texto: 'abc', minutos: 5 }]);
  });

  it('aba que sumiu (disable e reload de quem contribuiu) responde 404 ao vivo', async () => {
    const { get, post } = await start();
    expect((await get(`${W}/resumo`)).status).toBe(200);
    expect((await get('/api/tabs/nada/x/y')).status).toBe(404);
    expect((await post('/api/plugins/reminders/disable')).status).toBe(200);
    expect((await get(`${W}/resumo`)).status).toBe(404);
    const keys = ((await (await get('/api/tabs')).json()) as { key: string }[]).map((t) => t.key);
    expect(keys).not.toContain('reminders/lembretes');
    expect((await post('/api/plugins/reminders/enable')).status).toBe(200);
    expect((await get(`${W}/resumo`)).status).toBe(200);
    expect((await post('/api/plugins/reminders/reload')).status).toBe(200);
    expect((await get(`${W}/resumo`)).status).toBe(200);
  });
});

// Contribuições mal formadas ou grandes: o dashboard se protege sem derrubar o resto.
const many = <T>(n: number, make: (i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => make(i));

const rude = definePlugin({
  name: 'rude',
  version: '1.0.0',
  engine: '<1.0.0',
  after: ['dashboard'],
  setup(ctx) {
    ctx.services.contribute('dashboard.tabs', {
      id: 'rude',
      title: 'Rude',
      order: Number.NaN,
      widgets: [
        {
          kind: 'form',
          id: 'chave',
          schema: z.object({ token: secret(z.string()).default('valor-secreto-real') }),
          submit: async () => undefined,
        },
        {
          // Schema cujo JSON Schema lança: o widget sai do manifesto, o resto fica.
          kind: 'form',
          id: 'quebra',
          schema: {
            toJSONSchema: () => {
              throw new Error('sem schema');
            },
          } as never,
          submit: async () => undefined,
        },
        {
          kind: 'stats',
          id: 'stats',
          load: async () =>
            [{ label: 'ok', value: 1 }, { label: 'obj', value: { a: 1 } }, { value: 2 }] as never,
        },
        {
          kind: 'table',
          id: 'linhas',
          columns: [{ key: 'a', label: 'A' }],
          load: async () => ({ rows: [{ id: 'x', a: 1 }, { a: 2 }] as never }),
        },
        {
          kind: 'stats',
          id: 'muitos',
          load: async () => many(60, (i) => ({ label: `s${i}`, value: i })),
        },
        {
          kind: 'table',
          id: 'grande',
          columns: [{ key: 'a', label: 'A' }],
          load: async () => ({ rows: many(600, (i) => ({ id: String(i), a: i })) }),
        },
        {
          kind: 'series',
          id: 'pontos',
          load: async ({ days }) => many(1100, (i) => ({ label: `${days}`, value: i })),
        },
      ],
    });
  },
});

describe('abas de plugins: contrato defensivo', () => {
  async function startRude() {
    const http = createHttp({ port: 0, hostname: '127.0.0.1' });
    const bot = await createTestBot({
      plugins: [dashboard, rude],
      http,
      logLevel: 'info',
      pluginConfig: { dashboard: { token: TOKEN } },
    });
    bots.push(bot);
    const url = `http://127.0.0.1:${http.port}/plugins/dashboard`;
    const login = await fetch(`${url}/api/login`, {
      method: 'POST',
      body: JSON.stringify({ token: TOKEN }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const get = (path: string) => fetch(`${url}${path}`, { headers: { cookie } });
    const warns = async () =>
      ((await (await get('/api/logs?level=warn')).json()) as { message: string }[]).map(
        (l) => l.message,
      );
    return { get, warns };
  }
  const R = '/api/tabs/rude/rude';

  it('manifesto: default secret mascarado, widget sem schema sai, order inválido vira 0', async () => {
    const { get, warns } = await startRude();
    const raw = await (await get('/api/tabs')).text();
    expect(raw).not.toContain('valor-secreto-real');
    const [tab] = JSON.parse(raw) as { order: number; widgets: { id: string }[] }[];
    expect(tab?.order).toBe(0);
    expect(tab?.widgets.map((w) => w.id)).not.toContain('quebra');
    expect(tab?.widgets.map((w) => w.id)).toContain('chave');
    expect((await warns()).some((m) => m.includes('widget "quebra" ignorado'))).toBe(true);
  });

  it('descarta itens fora do contrato do load, com warn', async () => {
    const { get, warns } = await startRude();
    expect(await (await get(`${R}/stats`)).json()).toEqual([{ label: 'ok', value: 1 }]);
    expect(await (await get(`${R}/linhas`)).json()).toEqual({ rows: [{ id: 'x', a: 1 }] });
    expect((await warns()).filter((m) => m.includes('fora do contrato'))).toHaveLength(2);
  });

  it('corta em 50 stats, 500 linhas e 1000 pontos, com warn; days fora da faixa é limitado', async () => {
    const { get, warns } = await startRude();
    expect(((await (await get(`${R}/muitos`)).json()) as unknown[]).length).toBe(50);
    const table = (await (await get(`${R}/grande`)).json()) as { rows: unknown[] };
    expect(table.rows.length).toBe(500);
    expect(((await (await get(`${R}/pontos`)).json()) as unknown[]).length).toBe(1000);
    expect((await warns()).filter((m) => m.includes('cortado em'))).toHaveLength(3);
    const label = async (q: string) =>
      ((await (await get(`${R}/pontos${q}`)).json()) as { label: string }[])[0]?.label;
    expect(await label('?days=99999')).toBe('365');
    expect(await label('?days=0')).toBe('30');
    expect(await label('?days=-5')).toBe('30');
    expect(await label('?days=2.5')).toBe('30');
  });
});

// ADR 0118: título por widget, tom de `stats` e rótulo do botão do `form`.
const rotulos = definePlugin({
  name: 'rotulos',
  version: '1.0.0',
  engine: '<1.0.0',
  after: ['dashboard'],
  setup(ctx) {
    ctx.services.contribute('dashboard.tabs', {
      id: 'rotulos',
      title: 'Rótulos',
      widgets: [
        {
          kind: 'stats',
          id: 'resumo',
          load: async () =>
            [
              { label: 'Atrasados', value: 1, tone: 'warn' },
              { label: 'Pendentes', value: 2 },
              { label: 'Futuro', value: 3, tone: 'roxo' },
            ] as never,
        },
        {
          kind: 'table',
          id: 'proximos',
          title: 'Próximos',
          columns: [{ key: 'a', label: 'A' }],
          load: async () => ({ rows: [] }),
        },
        {
          kind: 'form',
          id: 'novo',
          title: 'Novo lembrete global',
          submitLabel: 'Agendar',
          schema: z.object({ texto: z.string() }),
          submit: async () => undefined,
        },
        {
          kind: 'form',
          id: 'ruim',
          title: 7,
          submitLabel: 1,
          schema: z.object({ texto: z.string() }),
          submit: async () => undefined,
        } as never,
      ],
    });
  },
});

describe('abas de plugins: título, tom e rótulo do envio', () => {
  async function startRotulos() {
    const http = createHttp({ port: 0, hostname: '127.0.0.1' });
    const bot = await createTestBot({
      plugins: [dashboard, rotulos],
      http,
      pluginConfig: { dashboard: { token: TOKEN } },
    });
    bots.push(bot);
    const url = `http://127.0.0.1:${http.port}/plugins/dashboard`;
    const login = await fetch(`${url}/api/login`, {
      method: 'POST',
      body: JSON.stringify({ token: TOKEN }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    return (path: string) => fetch(`${url}${path}`, { headers: { cookie } });
  }

  it('manifesto leva title de qualquer widget e submitLabel do form; o que não é texto some', async () => {
    const get = await startRotulos();
    const [tab] = (await (await get('/api/tabs')).json()) as Record<string, unknown>[];
    const widgets = tab?.['widgets'] as Record<string, unknown>[];
    // O form `ruim` fica no manifesto: só o title e o submitLabel que não são texto saem.
    expect(widgets.map((w) => w['kind'])).toEqual(['stats', 'table', 'form', 'form']);
    expect(widgets.map((w) => w['title'])).toEqual([
      undefined,
      'Próximos',
      'Novo lembrete global',
      undefined,
    ]);
    expect(widgets[2]?.['submitLabel']).toBe('Agendar');
    expect(widgets[3]).not.toHaveProperty('submitLabel');
  });

  it('stats repassa tom conhecido e tira o desconhecido sem descartar o item', async () => {
    const get = await startRotulos();
    expect(await (await get('/api/tabs/rotulos/rotulos/resumo')).json()).toEqual([
      { label: 'Atrasados', value: 1, tone: 'warn' },
      { label: 'Pendentes', value: 2 },
      { label: 'Futuro', value: 3 },
    ]);
  });
});
