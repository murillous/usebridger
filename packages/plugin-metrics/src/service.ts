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
}

type Kind = 'counter' | 'histogram' | 'gauge';
type Labels = Readonly<Record<string, string>>;

interface Entry {
  /** Especificação serializada: a redeclaração só devolve o handle se for igual. */
  readonly spec: string;
  readonly handle: Counter<string> | Histogram<string> | Gauge<string>;
  /** Plugins que declararam, em ordem; o primeiro é o dono. */
  readonly declarers: string[];
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
  const { registry, log, maxSeriesPerMetric } = options;
  const entries = new Map<string, Entry>();

  function create(kind: Kind, spec: HistogramSpec<string>): Entry['handle'] {
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
        inc(labels: Labels, value = 1) {
          if (admit(labels, value)) metric.inc(labels, value);
        },
      };
    }
    if (kind === 'gauge') {
      const metric = new PromGauge(base);
      return {
        set(labels: Labels, value: number) {
          if (admit(labels, value)) metric.set(labels, value);
        },
      };
    }
    const metric = new PromHistogram(
      spec.buckets === undefined ? base : { ...base, buckets: [...spec.buckets] },
    );
    return {
      observe(labels: Labels, value: number) {
        if (admit(labels, value)) metric.observe(labels, value);
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
    const handle = create(kind, spec);
    entries.set(spec.name, { spec: key, handle, declarers: [caller] });
    return handle;
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
      if (entry.declarers.length === 0) {
        registry.removeSingleMetric(name);
        entries.delete(name);
      }
    }
  }

  return {
    service: serviceFor(CORE_OWNER),
    scoped: serviceFor,
    release,
    ownerOf: (name) => entries.get(name)?.declarers[0],
  };
}
