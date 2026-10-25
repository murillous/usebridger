// Núcleo do serviço: camada fina sobre o `prom-client` (ADR 0121). Valida a declaração, guarda o
// dono e aplica as guardas do handle; a contagem fica com o `prom-client`, na registry do bot.

import type { Logger } from '@usebridger/core';
import {
  Counter as PromCounter,
  Gauge as PromGauge,
  Histogram as PromHistogram,
  type Registry,
} from 'prom-client';
import type {
  Counter,
  Gauge,
  Histogram,
  HistogramSpec,
  MetricSpec,
  MetricsService,
} from '#types.ts';
import * as LOG from './log-events.ts';

export interface MetricsRuntimeOptions {
  readonly registry: Registry;
  readonly log: Logger;
  readonly maxSeriesPerMetric: number;
  /** Chamado na primeira declaração de uma métrica e quando o dono dela muda. */
  readonly onDescribe?: (descriptor: MetricDescriptor) => void;
}

type Kind = 'counter' | 'histogram' | 'gauge';
type Labels = Readonly<Record<string, string>>;

/** Descritor de uma métrica, como vai para a coleção `catalog`. */
export interface MetricDescriptor {
  readonly name: string;
  readonly type: Kind;
  readonly help: string;
  readonly labelNames: readonly string[];
  readonly buckets: readonly number[] | null;
  readonly owner: string;
}

/** Uma série lida da registry no flush. */
export interface Sample {
  readonly metric: string;
  readonly type: Kind;
  readonly labels: Labels;
  /**
   * Contador e histograma: o que somou desde a leitura anterior (`value`, ou `le:<limite>` por
   * balde não cumulativo, `sum` e `count`). Gauge: `last` e `max` desde a leitura anterior.
   */
  readonly fields: Readonly<Record<string, number>>;
}

/** Dono das métricas que o próprio plugin-metrics declara (kernel). */
export const CORE_OWNER = 'core';

export interface MetricsRuntime {
  /** Serviço do próprio plugin-metrics: o que ele declara tem o dono `core`. */
  readonly service: MetricsService;
  /** Serviço de um plugin consumidor: a primeira declaração de uma métrica grava `caller` como dono. */
  scoped(caller: string): MetricsService;
  /** O caller saiu: sai das métricas que declarou, e a que fica sem ninguém sai da registry. */
  release(caller: string): void;
  /** Quem declarou primeiro, entre os que ainda estão; `undefined` se a métrica não existe. */
  ownerOf(name: string): string | undefined;
  /** Lê a registry e devolve, por série, o que mudou desde a leitura anterior. */
  collect(): Promise<Sample[]>;
}

interface Series {
  readonly labels: Labels;
  readonly fields: Record<string, number>;
}

interface Entry {
  readonly kind: Kind;
  /** Especificação serializada: a redeclaração só devolve o handle se for igual. */
  readonly spec: string;
  readonly descriptor: Omit<MetricDescriptor, 'owner'>;
  readonly handle: Counter<string> | Histogram<string> | Gauge<string>;
  readonly metric: PromCounter | PromHistogram | PromGauge;
  /** Plugins que declararam, em ordem; o primeiro é o dono. */
  readonly declarers: string[];
  /** Contador e histograma: o total por série já entregue pelo `collect`, de onde sai o delta. */
  readonly baseline: Map<string, Record<string, number>>;
  /** Gauge: `last` e `max` por série desde o `collect` anterior, mantidos pelo `set`. */
  readonly gauges: Map<string, Series>;
}

/** Chave da série independente da ordem dos rótulos. */
export function seriesKey(labels: Labels): string {
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// Do runtime do Node (#239), que o `collectDefaultMetrics` preenche.
const RESERVED_PREFIXES = ['process_', 'nodejs_'];

// Ids de chat/usuário reconhecidos pelo formato, porque o core não expõe um reconhecedor:
// JID/handle com `@` (`...@s.whatsapp.net`, `...@g.us`, `...@lid`), telefone ou id numérico
// longo (Telegram etc.). shortcut: heurística de formato, um id opaco fora desses formatos
// passa; quem usa o serviço responde por não pôr id como rótulo. A #241 troca pelo do core.
const PERSONAL_ID_RE = /@|^\+?\d{7,}$|^-\d{5,}$/;

function assertSpec(kind: Kind, spec: HistogramSpec<string>): void {
  const { name, help, labelNames, buckets } = spec;
  const fail = (why: string): never => {
    throw new TypeError(`métrica "${String(name)}": ${why}`);
  };
  if (typeof name !== 'string' || !NAME_RE.test(name))
    fail('nome fora de ^[a-zA-Z_:][a-zA-Z0-9_:]*$');
  if (RESERVED_PREFIXES.some((p) => name.startsWith(p)))
    fail('prefixo reservado ao runtime do Node');
  if (kind === 'counter' && !name.endsWith('_total')) fail('contador precisa terminar em _total');
  if (typeof help !== 'string' || help === '') fail('help precisa ser texto não vazio');
  if (!Array.isArray(labelNames)) fail('labelNames precisa ser lista');
  const seen = new Set<string>();
  for (const label of labelNames) {
    if (typeof label !== 'string' || !LABEL_RE.test(label)) {
      fail(`rótulo "${String(label)}" fora de ^[a-zA-Z_][a-zA-Z0-9_]*$`);
    }
    if (seen.has(label)) fail(`rótulo "${label}" repetido`);
    // `le` é o rótulo dos baldes no formato do Prometheus.
    if (kind === 'histogram' && label === 'le') fail('histograma não aceita o rótulo "le"');
    seen.add(label);
  }
  if (buckets === undefined) return;
  if (!Array.isArray(buckets)) fail('buckets precisa ser lista');
  buckets.forEach((b, i) => {
    if (!Number.isFinite(b)) fail('buckets precisam ser números finitos');
    if (i > 0 && b <= (buckets[i - 1] ?? b)) fail('buckets precisam ser crescentes');
  });
}

export function createMetrics(options: MetricsRuntimeOptions): MetricsRuntime {
  const { registry, log, maxSeriesPerMetric, onDescribe } = options;
  const entries = new Map<string, Entry>();
  // Métricas que saíram da registry com delta ainda não lido: o próximo `collect` as lê uma vez.
  const retired: [string, Entry][] = [];

  function create(
    kind: Kind,
    spec: HistogramSpec<string>,
    gauges: Entry['gauges'],
  ): Pick<Entry, 'handle' | 'metric'> {
    const { name } = spec;
    const labelNames = [...spec.labelNames];
    const allowed = new Set(labelNames);
    const series = new Set<string>();
    let overflowWarned = false;

    // Guardas do caminho quente; `false` descarta a amostra sem lançar.
    const admit = (labels: Labels, value: number): boolean => {
      if (!Number.isFinite(value) || value < 0) {
        throw new TypeError(`métrica "${name}": o valor precisa ser número finito >= 0`);
      }
      for (const [k, v] of Object.entries(labels)) {
        if (!allowed.has(k)) {
          throw new TypeError(`métrica "${name}": o rótulo "${k}" não está em labelNames`);
        }
        if (typeof v !== 'string') {
          throw new TypeError(`métrica "${name}": o rótulo "${k}" precisa ser texto`);
        }
        if (PERSONAL_ID_RE.test(v)) {
          throw new TypeError(
            `métrica "${name}": o rótulo "${k}" parece id de chat ou de usuário; dado pessoal não vira rótulo`,
          );
        }
      }
      // Na ordem de `labelNames`, para a ordem das chaves da chamada não criar série nova.
      const key = JSON.stringify(labelNames.map((l) => labels[l] ?? null));
      if (series.has(key)) return true;
      if (series.size >= maxSeriesPerMetric) {
        // Destino explícito: descarta a amostra e avisa uma vez, em vez de lançar no caminho quente.
        if (!overflowWarned) {
          overflowWarned = true;
          log.event(LOG.seriesOverflow, { metric: name, maxSeriesPerMetric });
        }
        return false;
      }
      series.add(key);
      return true;
    };

    const base = { name, help: spec.help, labelNames, registers: [registry] };
    if (kind === 'counter') {
      const metric = new PromCounter(base);
      return {
        metric,
        handle: {
          inc(labels: Labels, value = 1) {
            if (admit(labels, value)) metric.inc(labels, value);
          },
        },
      };
    }
    if (kind === 'gauge') {
      const metric = new PromGauge(base);
      return {
        metric,
        handle: {
          set(labels: Labels, value: number) {
            if (!admit(labels, value)) return;
            metric.set(labels, value);
            // O `prom-client` só guarda o último valor; o histórico também quer o pico do período.
            const key = seriesKey(labels);
            const seen = gauges.get(key);
            gauges.set(key, {
              labels: { ...labels },
              fields: { last: value, max: Math.max(seen?.fields['max'] ?? value, value) },
            });
          },
        },
      };
    }
    const metric = new PromHistogram(
      spec.buckets === undefined ? base : { ...base, buckets: [...spec.buckets] },
    );
    return {
      metric,
      handle: {
        observe(labels: Labels, value: number) {
          if (admit(labels, value)) metric.observe(labels, value);
        },
      },
    };
  }

  function declare(kind: Kind, spec: HistogramSpec<string>, caller: string): Entry['handle'] {
    assertSpec(kind, spec);
    const key = JSON.stringify([kind, spec.help, spec.labelNames, spec.buckets ?? null]);
    const existing = entries.get(spec.name);
    if (existing) {
      if (existing.spec !== key) {
        throw new TypeError(
          `métrica "${spec.name}" já declarada com outra especificação por "${existing.declarers[0]}"`,
        );
      }
      if (!existing.declarers.includes(caller)) existing.declarers.push(caller);
      return existing.handle;
    }
    // Os gauges ao vivo do kernel vão direto na registry, fora do serviço.
    if (registry.getSingleMetric(spec.name)) {
      throw new TypeError(`métrica "${spec.name}" é do plugin-metrics`);
    }
    const gauges = new Map<string, Series>();
    const { handle, metric } = create(kind, spec, gauges);
    const descriptor = {
      name: spec.name,
      type: kind,
      help: spec.help,
      labelNames: [...spec.labelNames],
      buckets: spec.buckets === undefined ? null : [...spec.buckets],
    };
    entries.set(spec.name, {
      kind,
      spec: key,
      descriptor,
      handle,
      metric,
      declarers: [caller],
      baseline: new Map(),
      gauges,
    });
    onDescribe?.({ ...descriptor, owner: caller });
    return handle;
  }

  // Delta de uma métrica contra o que o `collect` anterior já entregou.
  async function read(name: string, entry: Entry, out: Sample[]): Promise<void> {
    if (entry.kind === 'gauge') {
      for (const g of entry.gauges.values()) {
        out.push({ metric: name, type: 'gauge', labels: g.labels, fields: g.fields });
      }
      entry.gauges.clear();
      return;
    }
    const { values } = await entry.metric.get();
    const current = new Map<string, Series>();
    const cumulative = new Map<string, number>();
    for (const v of values) {
      let labels = v.labels as Labels;
      let field = 'value';
      if (entry.kind === 'histogram') {
        // `_bucket` (cumulativo, com o rótulo `le`), `_sum` ou `_count`.
        field = 'metricName' in v ? String(v.metricName).slice(name.length + 1) : '';
        if (field === 'bucket') {
          const { le, ...rest } = labels;
          field = `le:${le}`;
          labels = rest;
        }
      }
      const key = seriesKey(labels);
      let s = current.get(key);
      if (!s) {
        s = { labels, fields: {} };
        current.set(key, s);
      }
      if (field.startsWith('le:')) {
        // O `prom-client` entrega os baldes cumulativos e em ordem; o histórico grava cada balde.
        s.fields[field] = v.value - (cumulative.get(key) ?? 0);
        cumulative.set(key, v.value);
      } else {
        s.fields[field] = v.value;
      }
    }
    for (const [key, s] of current) {
      const base = entry.baseline.get(key);
      entry.baseline.set(key, s.fields);
      const fields: Record<string, number> = {};
      for (const [field, total] of Object.entries(s.fields)) {
        const delta = total - (base?.[field] ?? 0);
        if (delta > 0) fields[field] = delta;
      }
      if (Object.keys(fields).length > 0) {
        out.push({ metric: name, type: entry.kind, labels: s.labels, fields });
      }
    }
  }

  async function collect(): Promise<Sample[]> {
    const out: Sample[] = [];
    for (const [name, entry] of [...entries, ...retired.splice(0)]) await read(name, entry, out);
    return out;
  }

  // Os casts ligam o handle genérico ao `L` da chamada; o `admit` faz a checagem em runtime.
  const serviceFor = (caller: string): MetricsService => ({
    counter: <L extends string>(spec: MetricSpec<L>) =>
      declare('counter', spec, caller) as Counter<L>,
    histogram: <L extends string>(spec: HistogramSpec<L>) =>
      declare('histogram', spec, caller) as Histogram<L>,
    gauge: <L extends string>(spec: MetricSpec<L>) => declare('gauge', spec, caller) as Gauge<L>,
  });

  function release(caller: string): void {
    for (const [name, entry] of entries) {
      const i = entry.declarers.indexOf(caller);
      if (i === -1) continue;
      entry.declarers.splice(i, 1);
      // Outro plugin que declarou a mesma métrica segue escrevendo nela e vira o dono; sem
      // ninguém, ela sai do /metrics e volta zerada na próxima declaração.
      const [owner] = entry.declarers;
      if (owner === undefined) {
        registry.removeSingleMetric(name);
        entries.delete(name);
        retired.push([name, entry]);
      } else if (i === 0) {
        onDescribe?.({ ...entry.descriptor, owner });
      }
    }
  }

  return {
    service: serviceFor(CORE_OWNER),
    scoped: serviceFor,
    release,
    ownerOf: (name) => entries.get(name)?.declarers[0],
    collect,
  };
}
