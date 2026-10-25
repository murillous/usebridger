// Histórico por hora e por dia (ADR 0121). O flush lê o delta da registry (`collect`) e o soma
// com `increment` nas coleções `hourly` e `daily`; o caminho quente continua com uma escrita só.
// Separado do plugin para não depender do contexto além do que `createHistory` recebe.

import type { Collection, Logger } from '@usebridger/core';
import { type Declaration, type Sample, seriesKey } from '#service.ts';
import type {
  Granularity,
  HistogramQueryRow,
  MetricDescriptor,
  MetricLabels,
  MetricQuery,
  MetricRow,
  MetricsExporter,
  QueryRow,
} from '#types.ts';
import * as LOG from './log-events.ts';

/** Um documento por (métrica, período, série, campo): o `increment` atômico mexe num campo só. */
export interface HistoryDoc {
  readonly [key: string]: string | number | MetricLabels;
  readonly metric: string;
  readonly period: string;
  readonly key: string;
  readonly field: string;
  readonly labels: MetricLabels;
  readonly value: number;
  // No `last` do gauge vai também `at` (ms do flush), para o `query` achar a amostra mais nova.
  // Fica sem campo tipado: a `Collection` exige `JsonValue` e não aceita propriedade opcional.
}

/** Descritor gravado na coleção `catalog`, um por nome. */
export type CatalogDoc = {
  readonly [key: string]: string | readonly string[] | readonly number[] | null;
} & {
  readonly name: string;
  readonly type: Declaration['type'];
  readonly help: string;
  readonly labelNames: readonly string[];
  readonly buckets: readonly number[] | null;
  readonly owner: string;
};

export interface HistoryOptions {
  readonly hourly: Collection<HistoryDoc>;
  readonly daily: Collection<HistoryDoc>;
  readonly catalog: Collection<CatalogDoc>;
  readonly log: Logger;
  readonly periods: (ms: number) => Periods;
  readonly retention: { readonly hourDays: number; readonly dayDays: number };
  /** O que mudou desde o flush anterior. */
  readonly collect: () => Promise<Sample[]>;
  /** O que o próximo `collect` devolveria, sem consumir. */
  readonly peek: () => Promise<Sample[]>;
  /** Declarações vivas no processo. */
  readonly live: () => readonly Declaration[];
  readonly exporters: () => readonly MetricsExporter[];
  readonly now?: () => number;
}

export interface History {
  /** Grava o delta; flushes ficam em fila, nunca dois ao mesmo tempo. */
  flush(): Promise<void>;
  /** Grava o descritor na `catalog`, na mesma fila do flush. */
  describe(descriptor: Declaration): void;
  query(query: MetricQuery): Promise<QueryRow[]>;
  catalog(): Promise<MetricDescriptor[]>;
}

export interface Periods {
  readonly hour: string;
  readonly day: string;
}

const DAY_MS = 86_400_000;
// Os limites do `prom-client` para histograma declarado sem `buckets` (ele não os exporta).
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const PERIOD_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?$/;

// Valida o período e devolve no formato da granularidade; o dia, na hora, vira a hora `edge`.
function toPeriod(value: unknown, granularity: Granularity, edge: '00' | '23'): string {
  const m = typeof value === 'string' ? PERIOD_RE.exec(value) : null;
  const [, y, mo, d, h] = m ?? [];
  // O round trip pelo `Date` recusa mês 13, 30 de fevereiro, hora 24.
  const iso = m ? new Date(Date.UTC(+(y ?? 0), +(mo ?? 0) - 1, +(d ?? 0), +(h ?? 0))) : null;
  const valid =
    iso !== null &&
    !Number.isNaN(iso.getTime()) &&
    iso.toISOString().slice(0, 13) === `${y}-${mo}-${d}T${h ?? '00'}` &&
    (h === undefined || granularity === 'hour');
  if (!valid) {
    const format = granularity === 'hour' ? 'YYYY-MM-DD ou YYYY-MM-DDTHH' : 'YYYY-MM-DD';
    throw new TypeError(`query: período "${String(value)}" fora do formato ${format}`);
  }
  if (granularity === 'day') return `${y}-${mo}-${d}`;
  return `${y}-${mo}-${d}T${h ?? edge}`;
}

/** Percentil `q` pelos baldes não cumulativos em ordem, como o `histogram_quantile`. */
export function quantile(
  q: number,
  buckets: readonly { readonly le: number; readonly count: number }[],
): number {
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  if (total === 0) return 0;
  const rank = q * total;
  let below = 0;
  for (const [i, b] of buckets.entries()) {
    // Balde vazio não tem onde interpolar; com `q = 0` ele daria 0/0.
    if (b.count === 0) continue;
    if (below + b.count < rank) {
      below += b.count;
      continue;
    }
    const lower = buckets[i - 1]?.le ?? 0;
    // No `+Inf` não há limite para interpolar: vale o maior finito.
    if (b.le === Number.POSITIVE_INFINITY) return lower;
    return lower + (b.le - lower) * ((rank - below) / b.count);
  }
  return buckets.at(-2)?.le ?? 0;
}

// Soma os baldes na união dos limites declarados e gravados. Se os limites mudaram entre
// períodos, é aproximação: a interpolação usa o limite anterior da união, não o do balde original.
function histogram(
  fields: ReadonlyMap<string, number>,
  limits: readonly number[],
): Omit<HistogramQueryRow, 'period' | 'labels'> {
  const counts = new Map<number, number>(
    [...limits, Number.POSITIVE_INFINITY].map((le) => [le, 0]),
  );
  for (const [field, value] of fields) {
    if (!field.startsWith('le:')) continue;
    const raw = field.slice(3);
    const le = raw === '+Inf' ? Number.POSITIVE_INFINITY : Number(raw);
    counts.set(le, (counts.get(le) ?? 0) + value);
  }
  const buckets = [...counts].sort(([a], [b]) => a - b).map(([le, count]) => ({ le, count }));
  return {
    type: 'histogram',
    count: fields.get('count') ?? 0,
    sum: fields.get('sum') ?? 0,
    buckets,
    p50: quantile(0.5, buckets),
    p95: quantile(0.95, buckets),
    p99: quantile(0.99, buckets),
  };
}

// Uma linha em construção: soma dos campos e, no gauge, o `last` mais novo de cada série.
interface Group {
  readonly period: string;
  readonly labels: MetricLabels;
  readonly fields: Map<string, number>;
  readonly lasts: Map<string, { readonly at: number; readonly value: number }>;
}

/** `true` se o `Intl` conhece o fuso IANA. */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Início da hora e do dia de um instante no fuso `timeZone`. */
export function createPeriods(timeZone: string): (ms: number) => Periods {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  return (ms) => {
    const part: Record<string, string> = {};
    for (const { type, value } of format.formatToParts(ms)) part[type] = value;
    const day = `${part['year']}-${part['month']}-${part['day']}`;
    return { day, hour: `${day}T${part['hour']}` };
  };
}

// Delta (contador e histograma) ou amostra (gauge) de uma série ainda não gravado num nível.
interface Pending {
  readonly metric: string;
  readonly type: Sample['type'];
  readonly key: string;
  readonly labels: MetricLabels;
  readonly fields: Map<string, number>;
}

// Junta a amostra ao pendente: o delta soma; no gauge, `last` fica com o mais novo e `max` só sobe.
function merge(target: Pending, field: string, value: number): void {
  const seen = target.fields.get(field);
  if (target.type !== 'gauge') target.fields.set(field, (seen ?? 0) + value);
  else if (field === 'max') target.fields.set(field, Math.max(seen ?? value, value));
  else target.fields.set(field, value);
}

function toRow(
  p: Pending,
  granularity: Granularity,
  period: string,
  written: Map<string, number>,
): MetricRow | undefined {
  if (written.size === 0) return undefined;
  const base = { metric: p.metric, granularity, period, labels: p.labels };
  if (p.type === 'counter') return { ...base, type: 'counter', value: written.get('value') ?? 0 };
  if (p.type === 'gauge') {
    const last = written.get('last') ?? written.get('max') ?? 0;
    return { ...base, type: 'gauge', last, max: written.get('max') ?? last };
  }
  const buckets: Record<string, number> = {};
  for (const [field, value] of written) {
    if (field.startsWith('le:')) buckets[field.slice(3)] = value;
  }
  return {
    ...base,
    type: 'histogram',
    count: written.get('count') ?? 0,
    sum: written.get('sum') ?? 0,
    buckets,
  };
}

export function createHistory(options: HistoryOptions): History {
  const { log, periods, retention } = options;
  const now = options.now ?? Date.now;
  const levels = [
    { granularity: 'hour', collection: options.hourly, pending: new Map<string, Pending>() },
    { granularity: 'day', collection: options.daily, pending: new Map<string, Pending>() },
  ] as const;
  let queue: Promise<void> = Promise.resolve();
  let purgedDay = '';

  // Serializa: dois flushes em paralelo gravariam o mesmo pendente duas vezes. O erro de uma
  // tarefa vai a quem chamou; o `catch` impede que a fila inteira fique rejeitada para sempre.
  function enqueue(task: () => Promise<void>): Promise<void> {
    const run = queue.catch(() => undefined).then(task);
    queue = run;
    return run;
  }

  async function write(
    collection: Collection<HistoryDoc>,
    p: Pending,
    period: string,
    field: string,
    value: number,
    at: number,
  ): Promise<void> {
    const where = { metric: p.metric, period, key: p.key, field };
    const doc = { ...where, labels: p.labels, value };
    if (p.type !== 'gauge') {
      // O core soma `by` ao `insert`, então ele vai com zero.
      await collection.increment(where, 'value', value, { insert: { ...doc, value: 0 } });
    } else if (field === 'last') {
      if ((await collection.update(where, { value, at })) === 0)
        await collection.insert({ ...doc, at });
    } else {
      const [stored] = await collection.find({ where, limit: 1 });
      if (stored)
        await collection.update({ id: stored.id }, { value: Math.max(stored.value, value) });
      else await collection.insert(doc);
    }
  }

  async function purge(today: string): Promise<void> {
    if (purgedDay === today) return;
    const at = now();
    await options.hourly.delete({ period: { lt: periods(at - retention.hourDays * DAY_MS).hour } });
    await options.daily.delete({ period: { lt: periods(at - retention.dayDays * DAY_MS).day } });
    purgedDay = today;
  }

  async function flush(): Promise<void> {
    const samples = await options.collect();
    const at = now();
    const period = periods(at);
    const rows: MetricRow[] = [];
    for (const level of levels) {
      for (const s of samples) {
        const key = seriesKey(s.labels);
        const id = `${s.metric}|${key}`;
        let p = level.pending.get(id);
        if (!p) {
          p = { metric: s.metric, type: s.type, key, labels: s.labels, fields: new Map() };
          level.pending.set(id, p);
        }
        for (const [field, value] of Object.entries(s.fields)) merge(p, field, value);
      }
      // O delta cai no período em que o flush roda, também o que voltou de um flush que falhou.
      const slot = level.granularity === 'hour' ? period.hour : period.day;
      for (const [id, p] of level.pending) {
        const written = new Map<string, number>();
        for (const [field, value] of p.fields) {
          try {
            await write(level.collection, p, slot, field, value, at);
            written.set(field, value);
            p.fields.delete(field);
          } catch (error) {
            // Não perde o dado: fica pendente e o próximo flush tenta de novo.
            log.event(LOG.writeFailed, { metric: p.metric, err: error });
          }
        }
        if (p.fields.size === 0) level.pending.delete(id);
        const row = toRow(p, level.granularity, slot, written);
        if (row) rows.push(row);
      }
    }
    try {
      await purge(period.day);
    } catch (error) {
      log.event(LOG.purgeFailed, { err: error });
    }
    if (rows.length === 0) return;
    const snapshot = { at: new Date(at).toISOString(), rows };
    try {
      for (const exporter of options.exporters()) {
        try {
          await exporter(snapshot);
        } catch (error) {
          log.event(LOG.exporterFailed, { err: error });
        }
      }
    } catch (error) {
      log.event(LOG.exportersListFailed, { err: error });
    }
  }

  // Fora da fila: um intervalo inválido falha na hora, sem esperar o flush em andamento.
  function range(q: MetricQuery): { level: (typeof levels)[number]; from: string; to: string } {
    const { granularity } = q;
    const level = levels.find((l) => l.granularity === granularity);
    if (!level)
      throw new TypeError(`query: granularity "${String(granularity)}" não é hour nem day`);
    const from = toPeriod(q.from, granularity, '00');
    const to = toPeriod(q.to, granularity, '23');
    if (from > to) throw new TypeError(`query: from "${q.from}" depois de to "${q.to}"`);
    const days = granularity === 'hour' ? retention.hourDays : retention.dayDays;
    if (from.slice(0, 10) < periods(now() - days * DAY_MS).day) {
      throw new TypeError(
        `query: from "${q.from}" fora da retenção de ${days} dias em ${granularity}`,
      );
    }
    return { level, from, to };
  }

  async function read(
    q: MetricQuery,
    { level, from, to }: ReturnType<typeof range>,
  ): Promise<QueryRow[]> {
    const { name, granularity, where = {}, groupBy } = q;
    const at = now();

    const groups = new Map<string, Group>();
    let type: Sample['type'] | undefined;
    const add = (
      period: string,
      labels: MetricLabels,
      field: string,
      value: number,
      sampledAt: number,
    ): void => {
      if (Object.entries(where).some(([k, v]) => labels[k] !== v)) return;
      // Sem catálogo, o tipo sai dos campos: `value` no contador, `last`/`max` no gauge.
      type ??=
        field === 'value' ? 'counter' : field === 'last' || field === 'max' ? 'gauge' : 'histogram';
      const picked = groupBy
        ? Object.fromEntries(
            groupBy.flatMap((k) => (labels[k] === undefined ? [] : [[k, labels[k]]])),
          )
        : labels;
      const id = `${period}|${seriesKey(picked)}`;
      let g = groups.get(id);
      if (!g) {
        g = { period, labels: picked, fields: new Map(), lasts: new Map() };
        groups.set(id, g);
      }
      const seen = g.fields.get(field);
      if (field === 'max') g.fields.set(field, Math.max(seen ?? value, value));
      else if (field !== 'last') g.fields.set(field, (seen ?? 0) + value);
      else {
        // Por série: o `last` mais novo dela; o empate fica com o que chegou depois (o delta).
        const series = seriesKey(labels);
        const prev = g.lasts.get(series);
        if (!prev || sampledAt >= prev.at) g.lasts.set(series, { at: sampledAt, value });
      }
    };

    const stored = await level.collection.find({
      where: { metric: name, period: { gte: from, lte: to } },
    });
    // Documento de antes do `at` conta como o mais antigo.
    for (const d of stored)
      add(d.period, d.labels, d.field, d.value, typeof d['at'] === 'number' ? d['at'] : 0);
    const slot = granularity === 'hour' ? periods(at).hour : periods(at).day;
    if (slot >= from && slot <= to) {
      // O não gravado é mais novo que qualquer gravado: o pendente de um flush que falhou e o
      // delta da registry, nessa ordem.
      for (const p of level.pending.values()) {
        if (p.metric !== name) continue;
        for (const [field, value] of p.fields)
          add(slot, p.labels, field, value, Number.POSITIVE_INFINITY);
      }
      for (const s of await options.peek()) {
        if (s.metric !== name) continue;
        for (const [field, value] of Object.entries(s.fields)) {
          add(slot, s.labels, field, value, Number.POSITIVE_INFINITY);
        }
      }
    }
    if (groups.size === 0) return [];

    const declared =
      options.live().find((d) => d.name === name) ??
      (await options.catalog.find({ where: { name }, limit: 1 }))[0];
    type = declared?.type ?? type;
    const limits = type === 'histogram' && declared ? (declared.buckets ?? DEFAULT_BUCKETS) : [];
    const rows: QueryRow[] = [];
    for (const g of groups.values()) {
      const base = { period: g.period, labels: g.labels };
      const f = (field: string): number => g.fields.get(field) ?? 0;
      if (type === 'counter') rows.push({ ...base, type, value: f('value') });
      else if (type === 'gauge') {
        // Agrupado, a soma do valor atual de cada série (a fila por prioridade vira o total).
        const lasts = [...g.lasts.values()];
        const last = lasts.length > 0 ? lasts.reduce((sum, l) => sum + l.value, 0) : f('max');
        rows.push({ ...base, type, last, max: g.fields.get('max') ?? last });
      } else rows.push({ ...base, ...histogram(g.fields, limits) });
    }
    return rows.sort((a, b) =>
      a.period === b.period
        ? seriesKey(a.labels) < seriesKey(b.labels)
          ? -1
          : 1
        : a.period < b.period
          ? -1
          : 1,
    );
  }

  async function catalog(): Promise<MetricDescriptor[]> {
    const out = new Map<string, MetricDescriptor>();
    const descriptor = (d: Omit<Declaration, 'owner'>, owner?: string): MetricDescriptor => ({
      name: d.name,
      type: d.type,
      help: d.help,
      labelNames: [...d.labelNames],
      ...(d.type === 'histogram' ? { buckets: [...(d.buckets ?? DEFAULT_BUCKETS)] } : {}),
      ...(owner === undefined ? { live: false } : { owner, live: true }),
    });
    for (const d of await options.catalog.find()) out.set(d.name, descriptor(d));
    for (const d of options.live()) out.set(d.name, descriptor(d, d.owner));
    return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  function describe(descriptor: Declaration): void {
    const { name, ...rest } = descriptor;
    // Nunca rejeita: a falha vai para o log e a próxima declaração (ou troca de dono) regrava.
    void enqueue(async () => {
      try {
        const patch = { ...rest, labelNames: [...rest.labelNames] };
        if ((await options.catalog.update({ name }, patch)) === 0) {
          await options.catalog.insert({ name, ...patch });
        }
      } catch (error) {
        log.event(LOG.catalogFailed, { metric: name, err: error });
      }
    });
  }

  // Na fila do flush: um flush nunca roda entre a leitura do gravado e a do delta, então o
  // `query` não conta em dobro nem perde o que o flush move da registry para o storage.
  const queued = <T>(task: () => Promise<T>): Promise<T> => {
    let result: T;
    return enqueue(async () => {
      result = await task();
    }).then(() => result);
  };
  return {
    flush: () => enqueue(flush),
    describe,
    query: async (q) => {
      const r = range(q);
      return queued(() => read(q, r));
    },
    catalog: () => queued(catalog),
  };
}
