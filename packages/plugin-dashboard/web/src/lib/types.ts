export interface StatusView {
  transport: string;
  session: string;
  status: 'connecting' | 'open' | 'closed';
  reason?: string;
  message?: string;
  qr?: string;
  pairingCode?: string;
  pairing?: boolean;
  updatedAt: number;
  /** Opcional: um backend anterior não envia. */
  versions?: { core: string; dashboard: string };
  /** Opcional: um backend anterior não envia. */
  outboundPending?: number;
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
  /** `Nome: mensagem` do erro lançado no setup (`setup-failed`), já censurado pelo core. */
  causeMessage?: string;
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
    }
  | { type: 'gauge'; day: string; labels: Record<string, string>; last: number; max: number };

export type MetricsResponse =
  | { available: false; reason?: 'version' }
  | {
      available: true;
      from: string;
      to: string;
      metrics: { name: string; rows: MetricRowView[]; plugin?: string }[];
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

// Manifesto de `GET /api/tabs` (ADR 0108): o servidor tira as funções; o `form` leva o JSON Schema.
export interface TabAction {
  id: string;
  label: string;
  confirm: boolean;
}

export type TabWidget =
  | { kind: 'stats'; id: string }
  | { kind: 'table'; id: string; columns: { key: string; label: string }[]; actions: TabAction[] }
  | { kind: 'series'; id: string; title?: string }
  | { kind: 'form'; id: string; schema: Record<string, unknown> }
  | { kind: 'text'; id: string; markdown: string };

export interface TabView {
  key: string;
  plugin: string;
  id: string;
  title: string;
  order: number;
  widgets: TabWidget[];
}

export type TabRow = { id: string } & Record<string, string | number | boolean | null>;
export interface StatItem {
  label: string;
  value: string | number;
  hint?: string;
}
export interface SeriesPoint {
  label: string;
  value: number;
}
