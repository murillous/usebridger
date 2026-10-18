export interface StatusView {
  transport: string;
  session: string;
  status: 'connecting' | 'open' | 'closed';
  reason?: string;
  message?: string;
  qr?: string;
  pairingCode?: string;
  updatedAt: number;
}

export interface LogEntry {
  level: string;
  time: number;
  message: string;
  fields?: unknown;
}

export type LiveMessage =
  | { type: 'snapshot'; status: StatusView; logs: LogEntry[] }
  | ({ type: 'status' } & StatusView)
  | { type: 'qr'; qr: string }
  | { type: 'pairing-code'; code: string }
  | { type: 'log'; entry: LogEntry };

export interface LifecycleError {
  plugin: string;
  phase: string;
  timedOut: boolean;
  message: string;
}

export interface SkipReason {
  kind: string;
  error?: LifecycleError;
  [key: string]: unknown;
}

export interface PluginRow {
  name: string;
  version: string;
  origin: string;
  status: 'loaded' | 'skipped';
  reason?: SkipReason;
  /** Comandos que o plugin pediu e o kernel deixou de fora (`UnregisteredCommand` do core). */
  unregistered?: { command: string }[];
  /** `dependsOn` do manifesto: nome → faixa semver. */
  dependsOn?: Record<string, string>;
  /** Serviços providos no `setup`. */
  services?: string[];
  /** Pontos de extensão a que o plugin contribuiu. */
  contributions?: string[];
}

export interface ChangeResult {
  plugin: PluginRow;
  dependents: PluginRow[];
  teardownErrors: LifecycleError[];
}

export type MetricRowView =
  | { type: 'counter'; day: string; labels: Record<string, string>; value: number }
  | {
      type: 'histogram';
      day: string;
      labels: Record<string, string>;
      count: number;
      sum: number;
      buckets: number[];
    };

export type MetricsResponse =
  | { available: false }
  | {
      available: true;
      from: string;
      to: string;
      metrics: { name: string; rows: MetricRowView[] }[];
    };

export interface ConfigIssue {
  path: string;
  message: string;
}

export interface ConfigResponse {
  view: { config: unknown; messages: unknown; sources: Record<string, string> } | null;
  schema: Record<string, unknown> | null;
  issues?: ConfigIssue[];
}
