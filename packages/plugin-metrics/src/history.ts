// Histórico por hora e por dia (ADR 0121). O flush lê o delta da registry (`collect`) e o soma
// com `increment` nas coleções `hourly` e `daily`; o caminho quente continua com uma escrita só.
// Separado do plugin para não depender do contexto além do que `createHistory` recebe.

import type { Collection, Logger } from '@usebridger/core';
import { type MetricDescriptor, type Sample, seriesKey } from '#service.ts';
import type { Granularity, MetricLabels, MetricRow, MetricsExporter } from '#types.ts';
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
}

/** Descritor gravado na coleção `catalog`, um por nome. */
export type CatalogDoc = {
  readonly [key: string]: string | readonly string[] | readonly number[] | null;
} & {
  readonly name: string;
  readonly type: MetricDescriptor['type'];
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
  readonly exporters: () => readonly MetricsExporter[];
  readonly now?: () => number;
}

export interface History {
  /** Grava o delta; flushes ficam em fila, nunca dois ao mesmo tempo. */
  flush(): Promise<void>;
  /** Grava o descritor na `catalog`, na mesma fila do flush. */
  describe(descriptor: MetricDescriptor): void;
}

export interface Periods {
  readonly hour: string;
  readonly day: string;
}

const DAY_MS = 86_400_000;

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
  ): Promise<void> {
    const where = { metric: p.metric, period, key: p.key, field };
    const doc = { ...where, labels: p.labels, value };
    if (p.type !== 'gauge') {
      // O core soma `by` ao `insert`, então ele vai com zero.
      await collection.increment(where, 'value', value, { insert: { ...doc, value: 0 } });
    } else if (field === 'last') {
      if ((await collection.update(where, { value })) === 0) await collection.insert(doc);
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
            await write(level.collection, p, slot, field, value);
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

  function describe(descriptor: MetricDescriptor): void {
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

  return { flush: () => enqueue(flush), describe };
}
