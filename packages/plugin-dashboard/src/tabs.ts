import {
  type ExtensionPoint,
  type HttpHandler,
  type Logger,
  maskedJsonSchema,
} from '@usebridger/core';
import type { z } from '@usebridger/core/zod';
import { sameOrigin } from '#auth.ts';
import { readLimited } from '#body.ts';

// Contrato do ponto `dashboard.tabs` (ADRs 0104, 0109 e 0114). Quem contribui importa só estes tipos.

/** Cor do valor de um `stats`: `warn` para atenção (atrasado), `danger` para falha, `ok` para sucesso. */
export type StatTone = 'ok' | 'warn' | 'danger';

export interface StatItem {
  label: string;
  value: string | number;
  /** Texto menor sob o valor (unidade, variação). */
  hint?: string;
  /** Sem ele, cor neutra. Tom desconhecido também vira neutro (ADR 0114). */
  tone?: StatTone;
}

export interface TableColumn {
  key: string;
  label: string;
}

/** Linha da tabela: `id` identifica a linha nas ações; as demais chaves são as colunas. */
export interface TableRow {
  id: string;
  [column: string]: string | number | boolean | null;
}

export interface SeriesPoint {
  /** Rótulo do eixo (dia, hora...), já formatado. */
  label: string;
  value: number;
}

export interface TableAction {
  id: string;
  label: string;
  /** Pede confirmação no browser antes do `run`. */
  confirm?: boolean;
  /** `row` vem do browser: confie no `id`, não nos outros campos. */
  run(input: { row: TableRow }): Promise<void>;
}

/** Campos de todo widget. `title` é o título do cartão; sem ele, o widget não tem título (ADR 0114). */
interface WidgetBase {
  id: string;
  title?: string;
}

export type DashboardWidget = WidgetBase &
  (
    | { kind: 'stats'; load(): Promise<StatItem[]> }
    | {
        kind: 'table';
        columns: TableColumn[];
        load(q: { cursor?: string }): Promise<{ rows: TableRow[]; cursor?: string }>;
        actions?: TableAction[];
      }
    | { kind: 'series'; load(q: { days: number }): Promise<SeriesPoint[]> }
    | {
        kind: 'form';
        schema: z.ZodType;
        /** Rótulo do botão de envio; sem ele, "Enviar". */
        submitLabel?: string;
        submit(input: unknown): Promise<void>;
      }
    | { kind: 'text'; markdown: string }
  );

export interface DashboardTab {
  /** `[a-z0-9-]{1,40}`, único dentro do plugin. */
  id: string;
  title: string;
  /** Dentro do grupo Extensões; empate pela ordem de carga. */
  order?: number;
  widgets: DashboardWidget[];
}

declare module '@usebridger/core' {
  interface ExtensionPoints {
    'dashboard.tabs': DashboardTab;
  }
}

const ID = /^[a-z0-9-]{1,40}$/;
const MAX_BODY = 64 * 1024;
// Corte de resposta (ADR 0104): `load` sem paginação não derruba o browser.
const MAX_ROWS = 500;
const MAX_POINTS = 1000;
const MAX_STATS = 50;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

const validStat = (s: unknown): boolean =>
  isRecord(s) &&
  typeof s['label'] === 'string' &&
  (typeof s['value'] === 'string' || Number.isFinite(s['value']));
const validPoint = (p: unknown): boolean =>
  isRecord(p) && typeof p['label'] === 'string' && Number.isFinite(p['value']);
const validRow = (r: unknown): boolean => isRecord(r) && typeof r['id'] === 'string';

const text = (body: string, status: number): Response => new Response(body, { status });
const gone = (): Response => text('aba não está mais disponível', 404);

const TONES = new Set<unknown>(['ok', 'warn', 'danger']);
// Tom fora da lista (plugin feito para um dashboard mais novo, ou erro) não derruba o item: só some.
const toneless = (s: StatItem): StatItem => {
  if (s.tone === undefined || TONES.has(s.tone)) return s;
  const { tone: _, ...rest } = s;
  return rest;
};
// Campo opcional de texto: o que não é string some do manifesto em vez de chegar ao browser.
const optText = (key: string, value: unknown) =>
  typeof value === 'string' ? { [key]: value } : {};

const isFn = (value: unknown): boolean => typeof value === 'function';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Motivo de recusa do widget, ou `undefined` se válido. Lê dado de plugin de terceiros: nada é presumido. */
function widgetProblem(w: unknown): string | undefined {
  if (!isRecord(w)) return 'widget não é objeto';
  if (typeof w['id'] !== 'string' || !ID.test(w['id'])) return 'id de widget inválido';
  switch (w['kind']) {
    case 'stats':
    case 'series':
      return isFn(w['load']) ? undefined : `${w['kind']} sem load`;
    case 'table': {
      const { columns, actions } = w;
      if (!isFn(w['load']) || !Array.isArray(columns) || columns.length === 0) {
        return 'table sem load ou columns';
      }
      if (
        !columns.every(
          (c) => isRecord(c) && typeof c['key'] === 'string' && typeof c['label'] === 'string',
        )
      ) {
        return 'table com coluna inválida';
      }
      if (actions !== undefined) {
        const ok =
          Array.isArray(actions) &&
          actions.every(
            (a) =>
              isRecord(a) &&
              typeof a['id'] === 'string' &&
              ID.test(a['id']) &&
              typeof a['label'] === 'string' &&
              isFn(a['run']),
          );
        if (!ok) return 'table com ação inválida';
      }
      return undefined;
    }
    case 'form':
      return isFn(w['submit']) && isRecord(w['schema']) && isFn(w['schema']['toJSONSchema'])
        ? undefined
        : 'form sem schema Zod ou submit';
    case 'text':
      return typeof w['markdown'] === 'string' ? undefined : 'text sem markdown';
    default:
      // `kind` novo num dashboard antigo: ignorado em silêncio relativo (warn uma vez), sem quebrar a aba.
      return `kind desconhecido "${String(w['kind'])}"`;
  }
}

interface OwnedTab {
  plugin: string;
  tab: DashboardTab;
}

/** Rotas `/api/tabs` (M5-4.6): leem `entries()` a cada pedido, então reload/disable tiram a aba na hora. */
export function registerTabRoutes(
  http: { route(method: 'GET' | 'POST', path: string, handler: HttpHandler): void },
  point: ExtensionPoint<DashboardTab>,
  log: Logger,
  guarded: (handler: HttpHandler) => HttpHandler,
): void {
  // Um warn por chave+motivo: a leitura é viva e o manifesto é pedido a cada navegação.
  const warned = new Set<string>();
  const warnOnce = (key: string, why: string): void => {
    const id = `${key}|${why}`;
    if (warned.has(id)) return;
    warned.add(id);
    log.warn(`dashboard: aba "${key}" ignorada: ${why}`);
  };

  const visible = (): OwnedTab[] => {
    const seen = new Set<string>();
    const out: OwnedTab[] = [];
    for (const { plugin, value: tab } of point.entries()) {
      const id = isRecord(tab) ? String(tab.id) : '?';
      const key = `${plugin}/${id}`;
      if (!isRecord(tab) || typeof tab.id !== 'string' || !ID.test(tab.id)) {
        warnOnce(key, 'id inválido');
        continue;
      }
      if (typeof tab.title !== 'string' || !Array.isArray(tab.widgets)) {
        warnOnce(key, 'title ou widgets inválidos');
        continue;
      }
      if (seen.has(key)) {
        warnOnce(key, 'id repetido no mesmo plugin (a primeira vence)');
        continue;
      }
      seen.add(key);
      // Widget inválido ou de `kind` novo sai sozinho; a aba segue com o resto.
      const ids = new Set<string>();
      const widgets = tab.widgets.filter((w) => {
        const problem = widgetProblem(w);
        if (problem) {
          warnOnce(`${key}`, `widget ignorado: ${problem}`);
          return false;
        }
        if (ids.has((w as { id: string }).id)) {
          warnOnce(key, `widget "${(w as { id: string }).id}" repetido (o primeiro vence)`);
          return false;
        }
        ids.add((w as { id: string }).id);
        return true;
      });
      // `order` vem de plugin de terceiros: NaN ou texto quebraria a ordenação.
      const order = typeof tab.order === 'number' && Number.isFinite(tab.order) ? tab.order : 0;
      out.push({ plugin, tab: { ...tab, order, widgets } });
    }
    // sort estável: o empate fica pela ordem de carga.
    return out.sort((a, b) => (a.tab.order ?? 0) - (b.tab.order ?? 0));
  };

  const manifestWidget = (w: DashboardWidget) => {
    const base = { kind: w.kind, id: w.id, ...optText('title', w.title) };
    switch (w.kind) {
      case 'table':
        return {
          ...base,
          columns: w.columns,
          actions: (w.actions ?? []).map(({ id, label, confirm }) => ({
            id,
            label,
            confirm: confirm === true,
          })),
        };
      case 'form':
        return {
          ...base,
          ...optText('submitLabel', w.submitLabel),
          // Mascarado como na Config: o `default` de campo secret não sai no manifesto.
          schema: maskedJsonSchema(w.schema),
        };
      case 'text':
        return { ...base, markdown: w.markdown };
      default:
        return base;
    }
  };

  http.route(
    'GET',
    '/api/tabs',
    guarded(() => {
      try {
        return Response.json(
          visible().map(({ plugin, tab }) => ({
            key: `${plugin}/${tab.id}`,
            plugin,
            id: tab.id,
            title: tab.title,
            order: tab.order ?? 0,
            // Um widget que não vira manifesto (ex.: `toJSONSchema` lança) sai sozinho; o resto fica.
            widgets: tab.widgets.flatMap((w) => {
              try {
                return [manifestWidget(w)];
              } catch (error) {
                warnOnce(
                  `${plugin}/${tab.id}`,
                  `widget "${w.id}" ignorado: ${String(error)}`.slice(0, 300),
                );
                return [];
              }
            }),
          })),
        );
      } catch (error) {
        log.error('dashboard: falha ao montar o manifesto de abas', { error });
        return text('erro interno', 500);
      }
    }),
  );

  // Acha o widget no estado atual; `undefined` é aba/widget que sumiu.
  const locate = (params: Record<string, string>) => {
    const plugin = params['plugin'] ?? '';
    const found = visible().find((t) => t.plugin === plugin && t.tab.id === params['tab']);
    const widget = found?.tab.widgets.find((w) => w.id === params['widget']);
    return found && widget
      ? { plugin, key: `${plugin}/${found.tab.id}/${widget.id}`, widget }
      : undefined;
  };

  const failed = (what: string, ctx: { plugin: string; key: string }, error: unknown): Response => {
    // Mensagem genérica ao browser: o erro do plugin pode trazer dado sensível.
    log.error(`dashboard: falha em ${what} da aba do plugin "${ctx.plugin}" (${ctx.key})`, {
      error,
    });
    return text('erro no widget', 500);
  };

  const num = (value: string | null, fallback: number, max: number): number => {
    const n = Number(value);
    return value !== null && Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
  };

  // Item fora do contrato sai com `warn`: o app renderiza o que recebe, e objeto como texto o derrubaria.
  const cut = <T>(
    items: unknown,
    max: number,
    ctx: { key: string },
    valid: (item: unknown) => boolean,
  ): T[] => {
    const all = Array.isArray(items) ? items : [];
    const list = all.filter(valid) as T[];
    if (list.length < all.length) {
      log.warn(
        `dashboard: widget "${ctx.key}" devolveu ${all.length - list.length} itens fora do contrato; descartados`,
      );
    }
    if (list.length <= max) return list;
    log.warn(`dashboard: widget "${ctx.key}" devolveu ${list.length} itens; cortado em ${max}`);
    return list.slice(0, max);
  };

  http.route(
    'GET',
    '/api/tabs/:plugin/:tab/:widget',
    guarded(async (request, info) => {
      const hit = locate(info.params);
      if (!hit) return gone();
      const { widget } = hit;
      const query = new URL(request.url).searchParams;
      try {
        switch (widget.kind) {
          case 'stats':
            return Response.json(
              cut<StatItem>(await widget.load(), MAX_STATS, hit, validStat).map(toneless),
            );
          case 'series':
            return Response.json(
              cut(
                await widget.load({ days: num(query.get('days'), DEFAULT_DAYS, MAX_DAYS) }),
                MAX_POINTS,
                hit,
                validPoint,
              ),
            );
          case 'table': {
            const cursor = query.get('cursor') ?? undefined;
            const page = await widget.load(cursor === undefined ? {} : { cursor });
            return Response.json({
              rows: cut(page?.rows, MAX_ROWS, hit, validRow),
              ...(typeof page?.cursor === 'string' ? { cursor: page.cursor } : {}),
            });
          }
          default:
            // form e text não têm dado a carregar.
            return text('widget sem dados', 404);
        }
      } catch (error) {
        return failed('load', hit, error);
      }
    }),
  );

  http.route(
    'POST',
    '/api/tabs/:plugin/:tab/:widget/actions/:action',
    guarded(async (request, info) => {
      // Cookie SameSite=Strict já protege; o Origin é a segunda barreira contra CSRF.
      if (!sameOrigin(request)) return text('origem inválida', 403);
      const hit = locate(info.params);
      if (!hit) return gone();
      const action =
        hit.widget.kind === 'table'
          ? hit.widget.actions?.find((a) => a.id === info.params['action'])
          : undefined;
      if (!action) return text('ação desconhecida', 404);
      const body = await readLimited(request, MAX_BODY);
      if (body === undefined) return text('corpo grande demais', 413);
      let row: unknown;
      try {
        row = (JSON.parse(body) as { row?: unknown }).row;
      } catch {
        return text('JSON inválido', 400);
      }
      if (!isRecord(row) || typeof row['id'] !== 'string') return text('linha inválida', 400);
      try {
        await action.run({ row: row as TableRow });
        return new Response(null, { status: 204 });
      } catch (error) {
        return failed('ação', hit, error);
      }
    }),
  );

  http.route(
    'POST',
    '/api/tabs/:plugin/:tab/:widget/submit',
    guarded(async (request, info) => {
      if (!sameOrigin(request)) return text('origem inválida', 403);
      const hit = locate(info.params);
      if (!hit) return gone();
      if (hit.widget.kind !== 'form') return text('widget não é formulário', 404);
      const { widget } = hit;
      const body = await readLimited(request, MAX_BODY);
      if (body === undefined) return text('corpo grande demais', 413);
      let input: unknown;
      try {
        input = JSON.parse(body);
      } catch {
        return text('JSON inválido', 400);
      }
      try {
        const parsed = await widget.schema.safeParseAsync(input);
        if (!parsed.success) {
          return Response.json(
            {
              error: 'invalid',
              issues: parsed.error.issues.map(({ path, message }) => ({
                path: path.map(String).join('.'),
                message,
              })),
            },
            { status: 400 },
          );
        }
        await widget.submit(parsed.data);
        return new Response(null, { status: 204 });
      } catch (error) {
        return failed('submit', hit, error);
      }
    }),
  );
}
