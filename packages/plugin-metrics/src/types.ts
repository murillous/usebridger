// Tipos públicos do plugin: o serviço `metrics` e o ponto de extensão `metrics.exporters`.

/** Rótulos de uma série: nome → valor. Nunca id de chat nem de usuário (ADR 0107). */
export type MetricLabels = Readonly<Record<string, string>>;

/** Limites superiores (ms) dos baldes do histograma; acima do último vai um balde `+Inf`. */
export const HISTOGRAM_BUCKETS: readonly number[] = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000,
];

/** Intervalo de dias inclusivo, `YYYY-MM-DD` em UTC. */
export interface MetricsRange {
  readonly from: string;
  readonly to: string;
}

/** Uma série de contador num dia. */
export interface CounterRow {
  readonly metric: string;
  readonly type: 'counter';
  readonly day: string;
  readonly labels: MetricLabels;
  readonly value: number;
}

/** Uma série de histograma num dia; percentis saem dos baldes (limite superior do balde). */
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
  /** Contagem por balde, alinhada a `HISTOGRAM_BUCKETS` mais um `+Inf` no fim. */
  readonly buckets: readonly number[];
}

export type MetricRow = CounterRow | HistogramRow;

/** O que um flush entrega a cada exportador: só o que foi agregado desde o flush anterior. */
export interface MetricsSnapshot {
  /** Instante do flush, ISO 8601. */
  readonly at: string;
  readonly rows: readonly MetricRow[];
}

/** Contribuição ao ponto `metrics.exporters`. Erro vai para o log e não derruba o flush. */
export type MetricsExporter = (snapshot: MetricsSnapshot) => void | Promise<void>;

export interface MetricsService {
  /** Soma `value` (>= 0, padrão 1) ao contador. `TypeError` se algum rótulo for id pessoal. */
  counter(name: string, labels: MetricLabels, value?: number): void;
  /** Registra uma observação (>= 0, em ms) no histograma. */
  observe(name: string, labels: MetricLabels, value: number): void;
  /** Linhas por dia e rótulos: o persistido mais o que ainda está em memória. */
  query(name: string, range: MetricsRange): Promise<MetricRow[]>;
  /** Nomes das métricas com dados no intervalo (persistidos ou em memória), em ordem alfabética. */
  names(range: MetricsRange): Promise<string[]>;
  /**
   * Registra o plugin criador da métrica (aparece em Métricas). O serviço é um objeto só para
   * todos os plugins, então ele não sabe quem chama: quem cria a métrica se declara. A primeira
   * declaração vale; as seguintes são ignoradas.
   */
  declareOwner(name: string, plugin: string): void;
  /** Plugin declarado dono da métrica; `undefined` se ninguém declarou. */
  ownerOf(name: string): string | undefined;
}

declare module '@usebridger/core' {
  interface Services {
    metrics: MetricsService;
  }
  interface ExtensionPoints {
    'metrics.exporters': MetricsExporter;
  }
}
