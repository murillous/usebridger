import type { Capability } from '#transport/capabilities.ts';

/** Fase do lifecycle em que um plugin falhou. `context` = a fábrica do contexto lançou. */
export type PluginPhase = 'context' | 'setup' | 'teardown' | 'dispose';

/** Falha de um plugin numa fase do lifecycle; o erro original fica em `cause`. */
export class PluginLifecycleError extends Error {
  override readonly name = 'PluginLifecycleError';
  readonly plugin: string;
  readonly phase: PluginPhase;
  /** `true` quando a fase estourou o prazo. */
  readonly timedOut: boolean;
  /** O que aconteceu, sem o prefixo do plugin (ex.: `excedeu 5000 ms`). */
  readonly detail: string;

  constructor(
    plugin: string,
    phase: PluginPhase,
    detail: string,
    timedOut: boolean,
    cause?: unknown,
  ) {
    super(`plugin "${plugin}" (${phase}): ${detail}`, { cause });
    this.plugin = plugin;
    this.phase = phase;
    this.timedOut = timedOut;
    this.detail = detail;
  }
}

/** Por que um plugin não está carregado. */
export type PluginSkipReason =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'engine'; readonly range: string; readonly coreVersion: string }
  | { readonly kind: 'capabilities'; readonly missing: readonly Capability[] }
  | { readonly kind: 'transport'; readonly expected: readonly string[]; readonly actual: string }
  | { readonly kind: 'dependency-missing'; readonly dependency: string }
  | { readonly kind: 'dependency-skipped'; readonly dependency: string }
  | {
      readonly kind: 'dependency-version';
      readonly dependency: string;
      readonly range: string;
      readonly version: string;
    }
  | { readonly kind: 'setup-failed'; readonly error: PluginLifecycleError };

interface ReportBase {
  readonly name: string;
  readonly version: string;
  /** `'config'` ou caminho do módulo (ver `PluginEntry`). */
  readonly origin: string;
}

/**
 * Comando que o plugin pediu e o kernel deixou de fora por capability ausente (ADR 0090) ou por
 * serviço não provido (ADR 0099).
 */
export interface UnregisteredCommand {
  readonly command: string;
  /** Capabilities ausentes no transport; vazio quando só falta serviço. */
  readonly missing: readonly Capability[];
  /** Serviços de `services` que ninguém provia no registro. Só aparece quando falta algum. */
  readonly services?: readonly string[];
}

/** Uma linha da tabela de boot. A tabela segue a ordem de carga. */
export type PluginReportEntry =
  | (ReportBase & {
      readonly status: 'loaded';
      /**
       * Comandos do `setup` que não entraram no registro, na ordem em que foram pedidos. Só
       * aparece quando há algum: o plugin carregou, mas parte dele não responde neste transport.
       */
      readonly unregistered?: readonly UnregisteredCommand[];
    })
  | (ReportBase & { readonly status: 'skipped'; readonly reason: PluginSkipReason });

/** Motivo em texto curto, como aparece na tabela de boot. */
export function describeSkipReason(reason: PluginSkipReason): string {
  switch (reason.kind) {
    case 'disabled':
      return 'desabilitado em disabledPlugins';
    case 'engine':
      return `engine incompatível: exige core ${reason.range}, versão atual ${reason.coreVersion}`;
    case 'capabilities':
      return `capability ausente no transport: ${reason.missing.join(', ')}`;
    case 'transport':
      return `transport diferente: exige ${reason.expected.join(' ou ')}, atual ${reason.actual}`;
    case 'dependency-missing':
      return `dependência ausente: ${reason.dependency}`;
    case 'dependency-skipped':
      return `dependência ignorada: ${reason.dependency}`;
    case 'dependency-version':
      return `dependência com versão incompatível: ${reason.dependency}@${reason.version} não satisfaz ${reason.range}`;
    case 'setup-failed': {
      const { error } = reason;
      const phase = error.phase === 'context' ? 'na criação do contexto' : 'no setup';
      const detail =
        error.timedOut || error.cause === undefined
          ? error.detail
          : error.cause instanceof Error
            ? error.cause.message
            : String(error.cause);
      return `falha ${phase}: ${detail}`;
    }
  }
}

/** Situação do plugin em texto curto, como aparece na tabela de boot. */
function describeStatus(entry: PluginReportEntry): string {
  if (entry.status === 'skipped') return `ignorado (${describeSkipReason(entry.reason)})`;
  if (!entry.unregistered) return 'carregado';
  const commands = entry.unregistered.map(
    ({ command, missing, services = [] }) =>
      `${command} (${[...missing, ...services.map((service) => `serviço ${service}`)].join(', ')})`,
  );
  return `carregado; sem ${commands.join(', ')}`;
}

/**
 * Tabela de boot para log, uma linha por plugin, alinhada em colunas:
 *
 * ```
 * Plugins: 2 carregado(s), 1 ignorado(s)
 *   sticker  1.2.0  carregado
 *   media    1.0.0  carregado; sem fig (send.sticker)
 *   ai       1.0.0  ignorado (capability ausente no transport: polls)
 * ```
 */
export function formatBootTable(entries: readonly PluginReportEntry[]): string {
  const loaded = entries.filter((entry) => entry.status === 'loaded').length;
  const header = `Plugins: ${loaded} carregado(s), ${entries.length - loaded} ignorado(s)`;
  const nameWidth = Math.max(0, ...entries.map((entry) => entry.name.length));
  const versionWidth = Math.max(0, ...entries.map((entry) => entry.version.length));
  const lines = entries.map(
    (entry) =>
      `  ${entry.name.padEnd(nameWidth)}  ${entry.version.padEnd(versionWidth)}  ${describeStatus(entry)}`,
  );
  return [header, ...lines].join('\n');
}
