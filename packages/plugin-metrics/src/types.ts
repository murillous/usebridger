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

/** Leitura do histórico. */
export interface MetricQuery {
  readonly name: string;
  /**
   * Primeiro período, inclusivo, no fuso da config: `YYYY-MM-DD`, ou `YYYY-MM-DDTHH` com
   * `granularity: 'hour'` (o dia sozinho vale da hora 00 à 23).
   */
  readonly from: string;
  /** Último período, inclusivo, no mesmo formato do `from`. */
  readonly to: string;
  readonly granularity: Granularity;
  /** Só as séries com esses rótulos iguais. */
  readonly where?: MetricLabels;
  /** Soma as séries pelos rótulos pedidos; `[]` é o total; ausente, uma linha por série. */
  readonly groupBy?: readonly string[];
}

interface QueryRowBase {
  /** Período, no formato da granularidade pedida. */
  readonly period: string;
  /** Os rótulos da série, ou só os do `groupBy`. */
  readonly labels: MetricLabels;
}

export interface CounterQueryRow extends QueryRowBase {
  readonly type: 'counter';
  readonly value: number;
}

export interface HistogramQueryRow extends QueryRowBase {
  readonly type: 'histogram';
  readonly count: number;
  readonly sum: number;
  /** Contagem por balde, não cumulativa, em ordem; o último `le` é `Infinity`. */
  readonly buckets: readonly { readonly le: number; readonly count: number }[];
  /** Percentis interpolados dentro do balde, como o `histogram_quantile` do Prometheus. */
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface GaugeQueryRow extends QueryRowBase {
  readonly type: 'gauge';
  /** O último valor da série; agrupado, a soma do último valor de cada série. */
  readonly last: number;
  readonly max: number;
}

export type QueryRow = CounterQueryRow | HistogramQueryRow | GaugeQueryRow;

/** Uma métrica conhecida: declarada no processo (`live`) ou só no histórico. */
export interface MetricDescriptor {
  readonly name: string;
  readonly type: 'counter' | 'histogram' | 'gauge';
  readonly help: string;
  readonly labelNames: readonly string[];
  /** Só no histograma: os limites finitos em uso. */
  readonly buckets?: readonly number[];
  /** Plugin dono (`core` no kernel); ausente se a métrica só existe no histórico. */
  readonly owner?: string;
  readonly live: boolean;
}

/**
 * Declara métricas e devolve o handle de escrita. A mesma especificação devolve o mesmo handle
 * (também a outro plugin); especificação diferente para o mesmo nome lança `TypeError`.
 */
export interface MetricsService {
  /** Contador: o nome termina em `_total`. */
  counter<const L extends string = never>(spec: MetricSpec<L>): Counter<L>;
  histogram<const L extends string = never>(spec: HistogramSpec<L>): Histogram<L>;
  gauge<const L extends string = never>(spec: MetricSpec<L>): Gauge<L>;
  /**
   * Agrega o histórico gravado com o delta ainda não gravado (no período corrente), sem contar
   * em dobro com um flush concorrente. Intervalo inválido ou fora da retenção lança `TypeError`.
   */
  query(query: MetricQuery): Promise<QueryRow[]>;
  /** Métricas declaradas no processo e as que só existem no histórico, por `name`. */
  catalog(): Promise<MetricDescriptor[]>;
}

declare module '@usebridger/core' {
  interface Services {
    metrics: MetricsService;
  }
  interface ExtensionPoints {
    'metrics.exporters': MetricsExporter;
  }
}
