// Núcleo do serviço: agregação em memória, flush em baldes diários e consulta. Separado do
// plugin para não depender do contexto além do que `createMetrics` recebe.

import type { Collection, Logger } from '@usebridger/core';
import {
  HISTOGRAM_BUCKETS,
  type MetricLabels,
  type MetricRow,
  type MetricsExporter,
  type MetricsRange,
  type MetricsService,
} from '#types.ts';

/** Um documento por (métrica, dia, série, campo): o `increment` atômico mexe num campo só. */
export interface MetricDoc {
  readonly [key: string]: string | number | MetricLabels;
  readonly metric: string;
  readonly day: string;
  readonly key: string;
  readonly field: string;
  readonly labels: MetricLabels;
  readonly value: number;
}

interface Cell {
  readonly day: string;
  readonly key: string;
  readonly labels: MetricLabels;
  readonly fields: Map<string, number>;
}

type Kind = 'counter' | 'histogram';

interface Metric {
  readonly kind: Kind;
  readonly series: Set<string>;
  cells: Map<string, Cell>;
  // Acumulado desde o início do processo, sem dia e sem zerar no flush: é o que o /metrics lê,
  // porque contador Prometheus que volta a zero a cada flush quebraria o `rate()`.
  readonly totals: Map<string, Cell>;
  overflowWarned: boolean;
}

export interface MetricsRuntimeOptions {
  readonly collection: Collection<MetricDoc>;
  readonly log: Logger;
  readonly exporters: () => readonly MetricsExporter[];
  readonly maxSeriesPerMetric: number;
  readonly retentionDays: number;
  readonly now?: () => number;
}

export interface MetricsRuntime {
  readonly service: MetricsService;
  /** Soma ao contador de um dia específico (o dia anterior, na virada); fora dos totais. */
  counterAt(name: string, labels: MetricLabels, value: number, day: string): void;
  /** Acumulado desde o início do processo (campo `day` vazio), para o /metrics. */
  totals(): MetricRow[];
  flush(): Promise<void>;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const BUCKET_FIELDS = [...HISTOGRAM_BUCKETS.map((b) => `le${b}`), 'leInf'];
const MAX_BOUND = HISTOGRAM_BUCKETS.at(-1) ?? 0;

// Ids de chat/usuário reconhecidos pelo formato, porque o core não expõe um reconhecedor:
// JID/handle com `@` (`...@s.whatsapp.net`, `...@g.us`, `...@lid`), telefone ou id numérico
// longo (Telegram etc.). shortcut: heurística de formato, um id opaco fora desses formatos
// passa; quem usa o serviço responde por não pôr id como rótulo.
const PERSONAL_ID_RE = /@|^\+?\d{7,}$|^-\d{5,}$/;

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function labelKey(labels: MetricLabels): string {
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function assertLabels(name: string, labels: MetricLabels): void {
  for (const [k, v] of Object.entries(labels)) {
    if (typeof v !== 'string') {
      throw new TypeError(`métrica "${name}": o rótulo "${k}" precisa ser texto`);
    }
    if (PERSONAL_ID_RE.test(v)) {
      throw new TypeError(
        `métrica "${name}": o rótulo "${k}" parece id de chat ou de usuário; dado pessoal não vira rótulo`,
      );
    }
  }
}

function assertValue(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`métrica "${name}": o valor precisa ser número finito >= 0`);
  }
}

// Limite superior do balde onde cai o posto `p`; o balde `+Inf` devolve o maior limite.
function percentile(buckets: readonly number[], count: number, p: number): number {
  const rank = Math.ceil(count * p);
  let acc = 0;
  for (let i = 0; i < buckets.length; i++) {
    acc += buckets[i] ?? 0;
    if (acc >= rank) return HISTOGRAM_BUCKETS[i] ?? MAX_BOUND;
  }
  return MAX_BOUND;
}

function toRow(metric: string, kind: Kind, c: Cell): MetricRow | undefined {
  if (kind === 'counter') {
    const value = c.fields.get('value') ?? 0;
    return value > 0 ? { metric, type: kind, day: c.day, labels: c.labels, value } : undefined;
  }
  const count = c.fields.get('count') ?? 0;
  if (count === 0) return undefined;
  const buckets = BUCKET_FIELDS.map((f) => c.fields.get(f) ?? 0);
  return {
    metric,
    type: kind,
    day: c.day,
    labels: c.labels,
    count,
    sum: c.fields.get('sum') ?? 0,
    p50: percentile(buckets, count, 0.5),
    p95: percentile(buckets, count, 0.95),
    p99: percentile(buckets, count, 0.99),
    buckets,
  };
}

function addTo(cell: Cell, field: string, by: number): void {
  cell.fields.set(field, (cell.fields.get(field) ?? 0) + by);
}

export function createMetrics(options: MetricsRuntimeOptions): MetricsRuntime {
  const { collection, log, maxSeriesPerMetric, retentionDays } = options;
  const now = options.now ?? Date.now;
  const metrics = new Map<string, Metric>();
  let flushing: Promise<void> = Promise.resolve();
  let purgedDay = '';
  let generation = 0;

  // Devolve a célula do dia e a do acumulado; vazio se a série estourou o limite.
  function cellFor(name: string, kind: Kind, labels: MetricLabels, dayAt?: string): Cell[] {
    assertLabels(name, labels);
    let metric = metrics.get(name);
    if (!metric) {
      metric = {
        kind,
        series: new Set(),
        cells: new Map(),
        totals: new Map(),
        overflowWarned: false,
      };
      metrics.set(name, metric);
    } else if (metric.kind !== kind) {
      throw new TypeError(`métrica "${name}" já existe como ${metric.kind}`);
    }
    const key = labelKey(labels);
    if (!metric.series.has(key)) {
      if (metric.series.size >= maxSeriesPerMetric) {
        // Destino explícito: descarta a amostra e avisa uma vez, em vez de lançar no caminho quente.
        if (!metric.overflowWarned) {
          metric.overflowWarned = true;
          log.warn('métrica passou do limite de séries; amostras de séries novas descartadas', {
            metric: name,
            maxSeriesPerMetric,
          });
        }
        return [];
      }
      metric.series.add(key);
    }
    const day = dayAt ?? dayOf(now());
    const id = `${day}|${key}`;
    let cell = metric.cells.get(id);
    if (!cell) {
      cell = { day, key, labels: { ...labels }, fields: new Map() };
      metric.cells.set(id, cell);
    }
    if (dayAt !== undefined) return [cell];
    let total = metric.totals.get(key);
    if (!total) {
      total = { day: '', key, labels: { ...labels }, fields: new Map() };
      metric.totals.set(key, total);
    }
    return [cell, total];
  }

  function counter(name: string, labels: MetricLabels, value = 1): void {
    assertValue(name, value);
    for (const cell of cellFor(name, 'counter', labels)) addTo(cell, 'value', value);
  }

  function counterAt(name: string, labels: MetricLabels, value: number, day: string): void {
    assertValue(name, value);
    for (const cell of cellFor(name, 'counter', labels, day)) addTo(cell, 'value', value);
  }

  function totals(): MetricRow[] {
    const rows: MetricRow[] = [];
    for (const [name, metric] of metrics) {
      for (const cell of metric.totals.values()) {
        const row = toRow(name, metric.kind, cell);
        if (row) rows.push(row);
      }
    }
    return rows;
  }

  function observe(name: string, labels: MetricLabels, value: number): void {
    assertValue(name, value);
    const i = HISTOGRAM_BUCKETS.findIndex((b) => value <= b);
    const bucket = BUCKET_FIELDS[i === -1 ? BUCKET_FIELDS.length - 1 : i] ?? 'leInf';
    for (const cell of cellFor(name, 'histogram', labels)) {
      addTo(cell, 'count', 1);
      addTo(cell, 'sum', value);
      addTo(cell, bucket, 1);
    }
  }

  async function purge(): Promise<void> {
    const today = dayOf(now());
    if (purgedDay === today) return;
    await collection.delete({ day: { lt: dayOf(now() - retentionDays * 86_400_000) } });
    purgedDay = today;
  }

  async function doFlush(): Promise<void> {
    const rows: MetricRow[] = [];
    for (const [name, metric] of metrics) {
      const cells = metric.cells;
      // Troca o mapa antes dos awaits: amostras novas durante a gravação vão para o próximo flush.
      metric.cells = new Map();
      for (const cell of cells.values()) {
        // Só entra no snapshot o que foi gravado: o que falhar volta ao agregado e sai no próximo flush.
        const written: Cell = { ...cell, fields: new Map() };
        for (const [field, value] of cell.fields) {
          if (value <= 0) continue;
          const where = { metric: name, day: cell.day, key: cell.key, field };
          try {
            await collection.increment(where, 'value', value, {
              insert: { ...where, labels: cell.labels, value: 0 }, // o core soma `by` ao insert
            });
            written.fields.set(field, value);
          } catch (error) {
            // Não perde o dado: devolve ao agregado para o próximo flush tentar de novo.
            log.error('falha ao gravar métrica; mantida em memória', { metric: name, error });
            const id = `${cell.day}|${cell.key}`;
            let target = metric.cells.get(id);
            if (!target) {
              target = { ...cell, fields: new Map() };
              metric.cells.set(id, target);
            }
            addTo(target, field, value);
          }
        }
        const row = toRow(name, metric.kind, written);
        if (row) rows.push(row);
      }
    }
    try {
      await purge();
    } catch (error) {
      log.error('falha ao apagar métricas antigas', { error });
    }
    if (rows.length === 0) return;
    const snapshot = { at: new Date(now()).toISOString(), rows };
    try {
      for (const exporter of options.exporters()) {
        try {
          await exporter(snapshot);
        } catch (error) {
          log.error('exportador de métricas falhou', { error });
        }
      }
    } catch (error) {
      log.error('falha ao listar exportadores de métricas', { error });
    }
  }

  // Marca início e fim de cada flush: o `query` detecta que um flush mexeu no agregado durante o `find`.
  async function tracked(): Promise<void> {
    generation++;
    try {
      await doFlush();
    } finally {
      generation++;
    }
  }

  // Serializa: dois flushes em paralelo gravariam o mesmo agregado duas vezes. O erro de um flush
  // vai a quem chamou; o `catch` impede que a fila inteira fique rejeitada para sempre.
  function flush(): Promise<void> {
    const run = flushing.catch(() => undefined).then(tracked);
    flushing = run;
    return run;
  }

  async function query(name: string, range: MetricsRange): Promise<MetricRow[]> {
    if (!DAY_RE.test(range.from) || !DAY_RE.test(range.to)) {
      throw new TypeError('query: from e to precisam ser YYYY-MM-DD');
    }
    // Espera o flush em andamento: sem isso o que está sendo gravado sumiria da soma.
    // Refaz se um flush começou ou terminou durante o `find`: ele esvaziaria a memória e a soma
    // contaria o dado em dobro ou o perderia.
    let docs: Awaited<ReturnType<typeof collection.find>>;
    for (;;) {
      await flushing.catch(() => undefined);
      const before = generation;
      docs = await collection.find({
        where: { metric: name, day: { gte: range.from, lte: range.to } },
      });
      if (before === generation) break;
    }
    const merged = new Map<string, Cell>();
    const take = (day: string, key: string, labels: MetricLabels): Cell => {
      const id = `${day}|${key}`;
      let cell = merged.get(id);
      if (!cell) {
        cell = { day, key, labels, fields: new Map() };
        merged.set(id, cell);
      }
      return cell;
    };
    let kind: Kind | undefined;
    for (const d of docs) {
      kind ??= d.field === 'value' ? 'counter' : 'histogram';
      addTo(take(d.day, d.key, d.labels), d.field, d.value);
    }
    const mem = metrics.get(name);
    if (mem) {
      kind = mem.kind;
      for (const c of mem.cells.values()) {
        if (c.day < range.from || c.day > range.to) continue;
        const cell = take(c.day, c.key, c.labels);
        for (const [f, v] of c.fields) addTo(cell, f, v);
      }
    }
    const k = kind;
    if (!k) return [];
    return [...merged.values()]
      .map((c) => toRow(name, k, c))
      .filter((r): r is MetricRow => r !== undefined)
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }

  // Mesma espera e mesmo intervalo do `query`; só o nome interessa, então não agrega nada.
  async function names(range: MetricsRange): Promise<string[]> {
    if (!DAY_RE.test(range.from) || !DAY_RE.test(range.to)) {
      throw new TypeError('names: from e to precisam ser YYYY-MM-DD');
    }
    await flushing.catch(() => undefined);
    const found = new Set<string>();
    const docs = await collection.find({ where: { day: { gte: range.from, lte: range.to } } });
    for (const d of docs) found.add(d.metric);
    for (const [name, metric] of metrics) {
      for (const c of metric.cells.values()) {
        if (c.day >= range.from && c.day <= range.to) found.add(name);
      }
    }
    return [...found].sort();
  }

  return { service: { counter, observe, query, names }, counterAt, totals, flush };
}
