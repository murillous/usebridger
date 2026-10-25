// Tipos públicos do plugin: o serviço `metrics` e o ponto de extensão `metrics.exporters`.

/** Rótulos de uma série gravada: nome → valor. Nunca id de chat nem de usuário (ADR 0103). */
export type MetricLabels = Readonly<Record<string, string>>;

/**
 * Rótulos de uma escrita: só os declarados em `labelNames` e qualquer um pode faltar (fica ausente
 * na série). Rótulo não declarado não compila e é recusado em runtime.
 */
export type LabelValues<L extends string> = { readonly [K in L]?: string };

/** Declaração de uma métrica (ADR 0121). */
export interface MetricSpec<L extends string> {
  /** Nome Prometheus (`^[a-zA-Z_:][a-zA-Z0-9_:]*$`), com a unidade no nome (`_seconds`, `_bytes`). */
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly L[];
}

export interface HistogramSpec<L extends string> extends MetricSpec<L> {
  /** Limites superiores crescentes e finitos; sem eles, o padrão do `prom-client` (`0.005 … 10`). */
  readonly buckets?: readonly number[];
}

export interface Counter<L extends string> {
  /** Soma `value` (finito, >= 0, padrão 1). */
  inc(labels: LabelValues<L>, value?: number): void;
}

export interface Histogram<L extends string> {
  /** Registra uma observação (finita, >= 0), em segundos se for tempo. */
  observe(labels: LabelValues<L>, value: number): void;
}

export interface Gauge<L extends string> {
  /** Fixa o valor atual (finito, >= 0). */
  set(labels: LabelValues<L>, value: number): void;
}

/** Período do histórico: a hora (`YYYY-MM-DDTHH`) ou o dia (`YYYY-MM-DD`) no fuso da config. */
export type Granularity = 'hour' | 'day';

interface RowBase {
  readonly metric: string;
  readonly granularity: Granularity;
  /** Início do período no fuso da config: `YYYY-MM-DDTHH` na hora, `YYYY-MM-DD` no dia. */
  readonly period: string;
  readonly labels: MetricLabels;
}

/** O que um contador somou, gravado num período. */
export interface CounterRow extends RowBase {
  readonly type: 'counter';
  readonly value: number;
}

/** O que um histograma somou, gravado num período. */
export interface HistogramRow extends RowBase {
  readonly type: 'histogram';
  readonly count: number;
  readonly sum: number;
  /** Contagem por balde, não cumulativa, pelo limite superior (`'0.1'`, `'+Inf'`). */
  readonly buckets: Readonly<Record<string, number>>;
}

/** Amostra de um gauge gravada num período: o último valor e o máximo desde o flush anterior. */
export interface GaugeRow extends RowBase {
  readonly type: 'gauge';
  readonly last: number;
  readonly max: number;
}

export type MetricRow = CounterRow | HistogramRow | GaugeRow;

/** O que um flush entrega a cada exportador: só o que ele gravou, nos dois períodos. */
export interface MetricsSnapshot {
  /** Instante do flush, ISO 8601. */
  readonly at: string;
  readonly rows: readonly MetricRow[];
}

/** Contribuição ao ponto `metrics.exporters`. Erro vai para o log e não derruba o flush. */
export type MetricsExporter = (snapshot: MetricsSnapshot) => void | Promise<void>;

/**
 * Declara métricas e devolve o handle de escrita. A mesma especificação devolve o mesmo handle
 * (também a outro plugin); especificação diferente para o mesmo nome lança `TypeError`.
 */
export interface MetricsService {
  /** Contador: o nome termina em `_total`. */
  counter<const L extends string = never>(spec: MetricSpec<L>): Counter<L>;
  histogram<const L extends string = never>(spec: HistogramSpec<L>): Histogram<L>;
  gauge<const L extends string = never>(spec: MetricSpec<L>): Gauge<L>;
}

declare module '@usebridger/core' {
  interface Services {
    metrics: MetricsService;
  }
  interface ExtensionPoints {
    'metrics.exporters': MetricsExporter;
  }
}
