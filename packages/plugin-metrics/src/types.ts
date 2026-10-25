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

/** Uma série de contador num dia. */
export interface CounterRow {
  readonly metric: string;
  readonly type: 'counter';
  readonly day: string;
  readonly labels: MetricLabels;
  readonly value: number;
}

/** Uma série de histograma num dia; percentis saem dos baldes. */
export interface HistogramRow {
  readonly metric: string;
  readonly type: 'histogram';
  readonly day: string;
  readonly labels: MetricLabels;
  readonly count: number;
  readonly sum: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  /** Contagem por balde, alinhada aos limites da métrica mais um `+Inf` no fim. */
  readonly buckets: readonly number[];
}

/** Uma série de gauge num dia: último valor amostrado e o máximo do dia. */
export interface GaugeRow {
  readonly metric: string;
  readonly type: 'gauge';
  readonly day: string;
  readonly labels: MetricLabels;
  readonly last: number;
  readonly max: number;
}

export type MetricRow = CounterRow | HistogramRow | GaugeRow;

/** O que um flush entrega a cada exportador: só o que foi agregado desde o flush anterior. */
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
