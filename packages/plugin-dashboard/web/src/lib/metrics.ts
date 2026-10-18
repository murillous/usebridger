// Leitura das linhas do serviço `metrics` para os painéis. Funções puras: a tela só desenha.
import type { MetricRowView, MetricsResponse } from './types.ts';

/** Nomes das métricas que o kernel mede sozinho (plugin-metrics); os painéis fixos leem estas. */
export const KERNEL = {
  handled: 'bridger.messages.handled',
  duration: 'bridger.messages.handle_duration_ms',
  sent: 'bridger.outbound.sent',
  users: 'bridger.active.users',
  groups: 'bridger.active.groups',
  pending: 'bridger.outbound.pending',
} as const;

// Espelha HISTOGRAM_BUCKETS do plugin-metrics (o app web não importa o pacote); o último é o `+Inf`.
const BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000];

export const rowsOf = (data: MetricsResponse, name: string): MetricRowView[] =>
  (data.available && data.metrics.find((m) => m.name === name)?.rows) || [];

const amount = (row: MetricRowView): number => (row.type === 'counter' ? row.value : row.count);

export const total = (rows: MetricRowView[]): number => rows.reduce((n, r) => n + amount(r), 0);

/** Soma por valor do rótulo `label`, do maior para o menor; linha sem o rótulo conta como "-". */
export function byLabel(rows: MetricRowView[], label: string): { key: string; value: number }[] {
  const sums = new Map<string, number>();
  for (const r of rows) {
    const key = r.labels[label] ?? '-';
    sums.set(key, (sums.get(key) ?? 0) + amount(r));
  }
  return [...sums].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
}

/** Dias `YYYY-MM-DD` de `from` a `to`, inclusive; o gráfico mostra dia sem dado como zero. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export function perDay(rows: MetricRowView[], days: string[]): { day: string; value: number }[] {
  return days.map((day) => ({
    day,
    value: total(rows.filter((r) => r.day === day)),
  }));
}

/** Percentil sobre os baldes somados de todas as linhas; vale o limite superior do balde. */
export function percentile(rows: MetricRowView[], p: number): number | undefined {
  const buckets: number[] = [];
  let count = 0;
  for (const r of rows) {
    if (r.type !== 'histogram') continue;
    count += r.count;
    r.buckets.forEach((n, i) => {
      buckets[i] = (buckets[i] ?? 0) + n;
    });
  }
  if (count === 0) return undefined;
  const rank = Math.ceil(count * p);
  let acc = 0;
  for (let i = 0; i < buckets.length; i++) {
    acc += buckets[i] ?? 0;
    // Balde `+Inf` (índice além dos limites): o valor passou do maior limite, não há teto a mostrar.
    if (acc >= rank) return BOUNDS[i] ?? Number.POSITIVE_INFINITY;
  }
  return Number.POSITIVE_INFINITY;
}

export interface Summary {
  name: string;
  type: 'counter' | 'histogram';
  series: number;
  /** Plugin que declarou a métrica; `core` para as do kernel. */
  plugin?: string;
  /** Contador: soma. Histograma: número de observações. */
  total: number;
  p95?: number;
}

/** Uma linha por métrica registrada, para a seção genérica. Métrica sem dado no período fica de fora. */
export function summarize(data: MetricsResponse): Summary[] {
  if (!data.available) return [];
  return data.metrics.flatMap(({ name, rows, plugin }) => {
    const first = rows[0];
    if (!first) return [];
    const series = new Set(rows.map((r) => JSON.stringify(Object.entries(r.labels).sort()))).size;
    const p95 = percentile(rows, 0.95);
    return [
      {
        name,
        type: first.type,
        series,
        ...(plugin === undefined ? {} : { plugin }),
        total: total(rows),
        ...(p95 === undefined ? {} : { p95 }),
      },
    ];
  });
}

/** Rótulo curto do eixo: "hoje" para o último dia, "12 out" para os outros. */
export function shortDay(day: string, today: string): string {
  if (day === today) return 'hoje';
  const parts = new Intl.DateTimeFormat('pt-BR', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).formatToParts(new Date(`${day}T00:00:00Z`));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')} ${get('month').replace('.', '')}`;
}

/**
 * Percentil por dia (limite do balde), para o gráfico de latência. `value` desenha a barra (dia sem
 * observação em zero, balde `+Inf` no maior teto); `text` é o valor para ler: "sem dado" ou "> 30.000 ms".
 */
export function percentilePerDay(
  rows: MetricRowView[],
  days: string[],
  p: number,
): { day: string; value: number; text: string }[] {
  return days.map((day) => {
    const v = percentile(
      rows.filter((r) => r.day === day),
      p,
    );
    return {
      day,
      value: v === undefined ? 0 : Number.isFinite(v) ? v : (BOUNDS.at(-1) ?? 0),
      text: v === undefined ? 'sem dado' : fmtMs(v),
    };
  });
}

/** Nomes dos rótulos usados pelas linhas, em ordem alfabética (`"status, route"` vira `"route, status"`). */
export const labelNames = (rows: MetricRowView[]): string[] =>
  [...new Set(rows.flatMap((r) => Object.keys(r.labels)))].sort();

export interface CatalogEntry extends Summary {
  labels: string[];
  /** Total do último dia do intervalo (contador) ou número de observações (histograma). */
  today: number;
  todayP95?: number;
}

/** `summarize` mais o que a tabela da tela mostra: rótulos e o valor de hoje. */
export function catalog(data: MetricsResponse): CatalogEntry[] {
  if (!data.available) return [];
  return summarize(data).map((s) => {
    const rows = data.metrics.find((m) => m.name === s.name)?.rows ?? [];
    const todayRows = rows.filter((r) => r.day === data.to);
    const todayP95 = percentile(todayRows, 0.95);
    return {
      ...s,
      labels: labelNames(rows),
      today: total(todayRows),
      ...(todayP95 === undefined ? {} : { todayP95 }),
    };
  });
}

/** URL do scrape do plugin-metrics, irmã do dashboard sob `/plugins/` (e sob `/sessions/<s>/plugins/`). */
export const scrapeUrl = (baseURI: string): string => new URL('../metrics/metrics', baseURI).href;

export const fmtInt = (n: number): string => n.toLocaleString('pt-BR');
/** Valor de um histograma de contagem (não de ms), como o p95 da fila de saída. */
export const fmtCount = (n: number | undefined): string =>
  n === undefined
    ? '-'
    : n === Number.POSITIVE_INFINITY
      ? `> ${fmtInt(BOUNDS[BOUNDS.length - 1] ?? 0)}`
      : fmtInt(n);
export const fmtMs = (n: number | undefined): string =>
  n === undefined
    ? '-'
    : n === Number.POSITIVE_INFINITY
      ? `> ${fmtInt(BOUNDS[BOUNDS.length - 1] ?? 0)} ms`
      : `${fmtInt(n)} ms`;
