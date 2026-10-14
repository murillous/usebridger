import type { Logger } from '#logger/types.ts';
import { type CapabilityHolder, missingCapabilities } from '#transport/capabilities.ts';
import { CORE_VERSION } from '#version.ts';
import { installDeclared, requiredCapabilities } from './declared.ts';
import { assertPluginDefinition } from './define.ts';
import { sortPlugins } from './order.ts';
import {
  describeSkipReason,
  formatBootTable,
  PluginLifecycleError,
  type PluginPhase,
  type PluginReportEntry,
  type PluginSkipReason,
  type UnregisteredCommand,
} from './report.ts';
import { isExactCaret, parseVersion, satisfies } from './semver.ts';
import type { PluginEntry } from './sources.ts';
import type { PluginContext, PluginDefinition } from './types.ts';

/**
 * Contexto de um plugin montado pelo `Bot`. `dispose` desfaz tudo o que o plugin registrou
 * por esse contexto (comandos, listeners, serviços, jobs) e roda sempre depois do `teardown` —
 * ou no lugar dele, quando o `setup` falhou no meio. `reason` é a falha do `setup` (o erro de
 * timeout, se ele estourou o prazo), que vira o motivo do `ctx.signal` abortado (ADR 0033).
 */
export interface PluginContextHandle {
  readonly context: PluginContext;
  /** Comandos que o contexto deixou de fora por capability ausente; vão para a tabela de boot. */
  unregisteredCommands?(): readonly UnregisteredCommand[];
  dispose(reason?: unknown): void | Promise<void>;
}

/** Monta o contexto de um plugin. O loader não conhece os serviços concretos (M1-16 fornece). */
export type PluginContextFactory = (
  plugin: PluginDefinition,
) => PluginContextHandle | Promise<PluginContextHandle>;

export interface PluginHostOptions {
  /** Plugins já coletados (ver `collectPlugins`), em ordem de declaração. */
  readonly plugins: readonly PluginEntry[];
  /** Nome e capabilities do transport ativo, conferidos contra `transports` e `requires`. */
  readonly transport: CapabilityHolder;
  readonly createContext: PluginContextFactory;
  readonly log: Logger;
  /** Nomes de plugin que não carregam. */
  readonly disabledPlugins?: readonly string[];
  /** Prazo de criação do contexto e de `setup` em ms. Padrão: 10000. */
  readonly setupTimeoutMs?: number;
  /** Prazo de `teardown` e de `dispose` em ms. Padrão: 5000. */
  readonly teardownTimeoutMs?: number;
  /** Versão conferida contra `engine`. Padrão: `CORE_VERSION`; existe para testes. */
  readonly coreVersion?: string;
}

/** `idle → starting → running → stopping → stopped`; `stopped` é terminal. */
export type PluginHostState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

/**
 * Resultado de `reload`, `disable` e `enable`: o que mudou no plugin e em quem depende dele.
 */
export interface PluginChangeResult {
  /**
   * Linha nova do plugin na tabela. Depois de `reload`: `loaded`, ou `skipped` se o `setup` novo
   * falhou. Depois de `disable`: `skipped` com `reason.kind` `disabled`. Depois de `enable`: a
   * linha que o boot daria agora.
   */
  readonly plugin: PluginReportEntry;
  /**
   * Linhas novas de quem depende dele (`dependsOn` ou `optionalDependsOn`, transitivo), descidos
   * e subidos em cascata, na ordem de carga. `dependency-skipped` se o plugin de que dependem
   * por `dependsOn` não subiu; o dependente opcional sobe mesmo assim.
   */
  readonly dependents: readonly PluginReportEntry[];
  /**
   * Falhas do `teardown`/`dispose` das instâncias que desceram (do plugin e dos dependentes; já
   * registradas no log). Falha do `setup` novo não entra aqui: fica no `reason` da linha do
   * plugin ou do dependente, como `setup-failed`.
   */
  readonly teardownErrors: readonly PluginLifecycleError[];
}

export interface PluginHost {
  readonly state: PluginHostState;
  /**
   * Valida, ordena e roda o `setup` de cada plugin compatível, em ordem topológica. Devolve a
   * tabela de boot (também logada). Rejeita — sem rodar nenhum `setup` — com
   * `PluginManifestError`, `PluginConflictError` ou `PluginCycleError`. Falha de um `setup`
   * não rejeita: o plugin e quem depende dele viram "ignorado".
   */
  start(): Promise<PluginReportEntry[]>;
  /**
   * `teardown` e `dispose` dos carregados, na ordem inversa da carga. Nunca rejeita por falha
   * de plugin: devolve as falhas (também logadas), e uma não impede o resto. Abortado o
   * `signal`, o `teardown` em curso é abandonado e os seguintes não rodam (cada um vira falha
   * com `timedOut`), mas o `dispose` de todos roda: o kernel desfaz o que o plugin registrou.
   * Idempotente: só o `signal` da primeira chamada vale.
   */
  stop(signal?: AbortSignal): Promise<PluginLifecycleError[]>;
  /**
   * Derruba e sobe de novo um plugin (`teardown` → `dispose` → novo contexto → `setup`) e, em
   * cascata, quem depende dele por `dependsOn` (ADR 0041) ou `optionalDependsOn` (ADR 0099): os
   * dependentes descem antes (ordem inversa) e sobem depois (ordem de carga), reavaliados como
   * no boot. É a primitiva do reload
   * por mudança de config (ADR 0017): o contexto novo sai da fábrica, que já lê a config
   * atualizada. Vale para plugin carregado ou cujo `setup` falhou.
   */
  reload(name: string): Promise<PluginChangeResult>;
  /**
   * Desliga um plugin em execução: desce ele e os dependentes (que viram `dependency-skipped`),
   * e não carrega mais até `enable`. Já desligado, não faz nada.
   */
  disable(name: string): Promise<PluginChangeResult>;
  /**
   * Liga um plugin desligado (por `disable` ou `disabledPlugins`) e sobe os dependentes que ele
   * libera. Já ligado, não faz nada.
   */
  enable(name: string): Promise<PluginChangeResult>;
  /** Tabela atual, na ordem de carga (reflete reloads). */
  report(): PluginReportEntry[];
}

/** Dois plugins com o mesmo `name` (ADR 0007). Erro no boot. */
export class PluginConflictError extends Error {
  override readonly name = 'PluginConflictError';
  readonly plugin: string;
  readonly origins: readonly string[];

  constructor(plugin: string, origins: readonly string[]) {
    super(
      `Dois plugins se chamam "${plugin}" (${origins.join(' e ')}). ` +
        'O nome identifica o plugin em config, storage e rotas: renomeie um deles.',
    );
    this.plugin = plugin;
    this.origins = origins;
  }
}

/** Operação incompatível com o estado do host ou do plugin. */
export class PluginHostStateError extends Error {
  override readonly name = 'PluginHostStateError';
}

export const DEFAULT_SETUP_TIMEOUT_MS = 10_000;
export const DEFAULT_TEARDOWN_TIMEOUT_MS = 5000;

interface Slot {
  readonly entry: PluginEntry;
  report: PluginReportEntry;
  handle: PluginContextHandle | undefined;
}

/**
 * Roda `fn` com prazo e devolve a falha em vez de lançar. A promise de `fn` sempre ganha um
 * handler, então um `setup` que rejeita depois do timeout não vira rejeição não tratada.
 * Abortado o `signal`, desiste na hora, como num timeout.
 */
async function runPhase<T>(
  plugin: string,
  phase: PluginPhase,
  timeoutMs: number,
  fn: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<{ ok: true; value: T } | { ok: false; error: PluginLifecycleError }> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  type Outcome = { ok: true; value: T } | { ok: false; error: PluginLifecycleError };
  const timeout = new Promise<Outcome>((resolve) => {
    const give = (message: string) => () =>
      resolve({ ok: false, error: new PluginLifecycleError(plugin, phase, message, true) });
    timer = setTimeout(give(`excedeu ${timeoutMs} ms`), timeoutMs);
    onAbort = give('abandonado: prazo de parada do bot esgotado');
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  // `then` captura também o throw síncrono.
  const run = Promise.resolve()
    .then(fn)
    .then(
      (value): Outcome => ({ ok: true, value }),
      (cause: unknown): Outcome => ({
        ok: false,
        error: new PluginLifecycleError(plugin, phase, 'falhou', false, cause),
      }),
    );
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

const reportBase = ({ definition, origin }: PluginEntry) => ({
  name: definition.name,
  version: definition.version,
  origin,
});

/** Cria o host de plugins. Não roda nada até `start()`. */
export function createPluginHost(options: PluginHostOptions): PluginHost {
  const { transport, createContext, log } = options;
  const coreVersion = options.coreVersion ?? CORE_VERSION;
  if (!parseVersion(coreVersion)) throw new RangeError(`coreVersion inválida: "${coreVersion}"`);
  const setupTimeoutMs = options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
  const teardownTimeoutMs = options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;
  const disabled = new Set(options.disabledPlugins ?? []);

  let state: PluginHostState = 'idle';
  let slots: Slot[] = [];
  const byName = new Map<string, Slot>();
  let stopPromise: Promise<PluginLifecycleError[]> | undefined;
  // start, stop e reload rodam um de cada vez: um reload no meio do stop deixaria contexto órfão.
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task);
    // A fila só precisa saber que a tarefa acabou; o erro chega a quem chamou por `result`.
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Motivo estático para não carregar, na ordem em que a tabela mostra. */
  function incompatibility(definition: PluginDefinition): PluginSkipReason | undefined {
    if (disabled.has(definition.name)) return { kind: 'disabled' };
    if (!satisfies(coreVersion, definition.engine)) {
      return { kind: 'engine', range: definition.engine, coreVersion };
    }
    if (definition.transports && !definition.transports.includes(transport.name)) {
      return { kind: 'transport', expected: definition.transports, actual: transport.name };
    }
    const missing = missingCapabilities(transport, requiredCapabilities(definition));
    if (missing.length > 0) return { kind: 'capabilities', missing };
    for (const [dependency, range] of Object.entries(definition.dependsOn ?? {})) {
      const slot = byName.get(dependency);
      if (!slot) return { kind: 'dependency-missing', dependency };
      const { version } = slot.entry.definition;
      if (!satisfies(version, range)) {
        return { kind: 'dependency-version', dependency, range, version };
      }
      // A ordem topológica garante que a dependência já foi decidida.
      if (slot.report.status !== 'loaded') return { kind: 'dependency-skipped', dependency };
    }
    return undefined;
  }

  /** Contexto + `setup`. Em falha, desfaz o que o plugin registrou e devolve o motivo. */
  async function bringUp(slot: Slot): Promise<PluginReportEntry> {
    const { definition } = slot.entry;
    const base = reportBase(slot.entry);
    const created = await runPhase(definition.name, 'context', setupTimeoutMs, () =>
      createContext(definition),
    );
    if (!created.ok) return fail(base, created.error);
    const handle = created.value;
    // O declarado entra na fase do `setup`: um conflito de nome falha e desfaz como na forma longa.
    const setup = await runPhase(definition.name, 'setup', setupTimeoutMs, () => {
      installDeclared(definition, handle.context);
      return definition.setup?.(handle.context);
    });
    if (!setup.ok) {
      // Sem teardown: ele pareia com um setup que terminou. O dispose limpa o registro parcial.
      const disposed = await runPhase(definition.name, 'dispose', teardownTimeoutMs, () =>
        handle.dispose(setup.error),
      );
      if (!disposed.ok) logLifecycleError(disposed.error);
      return fail(base, setup.error);
    }
    slot.handle = handle;
    const unregistered = [...(handle.unregisteredCommands?.() ?? [])];
    return { ...base, status: 'loaded', ...(unregistered.length > 0 && { unregistered }) };
  }

  function fail(
    base: ReturnType<typeof reportBase>,
    error: PluginLifecycleError,
  ): PluginReportEntry {
    logLifecycleError(error);
    return { ...base, status: 'skipped', reason: { kind: 'setup-failed', error } };
  }

  /** `teardown` (se houver) e `dispose`, sempre os dois; devolve as falhas. */
  async function bringDown(slot: Slot, signal?: AbortSignal): Promise<PluginLifecycleError[]> {
    const { handle } = slot;
    if (!handle) return [];
    slot.handle = undefined;
    const { definition } = slot.entry;
    const errors: PluginLifecycleError[] = [];
    if (definition.teardown && signal?.aborted) {
      errors.push(
        new PluginLifecycleError(
          definition.name,
          'teardown',
          'não executado: prazo de parada do bot esgotado',
          true,
        ),
      );
    } else if (definition.teardown) {
      const teardown = definition.teardown.bind(definition);
      const result = await runPhase(
        definition.name,
        'teardown',
        teardownTimeoutMs,
        () => teardown(handle.context),
        signal,
      );
      if (!result.ok) errors.push(result.error);
    }
    const disposed = await runPhase(definition.name, 'dispose', teardownTimeoutMs, () =>
      handle.dispose(),
    );
    if (!disposed.ok) errors.push(disposed.error);
    for (const error of errors) logLifecycleError(error);
    return errors;
  }

  function logLifecycleError(error: PluginLifecycleError): void {
    log.error(error.message, {
      plugin: error.plugin,
      phase: error.phase,
      timedOut: error.timedOut,
      err: error.cause ?? error,
    });
  }

  function logTable(entries: PluginReportEntry[]): void {
    const fields = {
      plugins: entries.map((entry) => ({
        name: entry.name,
        version: entry.version,
        origin: entry.origin,
        status: entry.status,
        ...(entry.status === 'skipped' ? { reason: describeSkipReason(entry.reason) } : {}),
        ...(entry.status === 'loaded' && entry.unregistered
          ? { unregistered: entry.unregistered }
          : {}),
      })),
    };
    const toReview = entries.some(
      (entry) => entry.status === 'skipped' || entry.unregistered !== undefined,
    );
    // Plugin ignorado ou comando deixado de fora é configuração a revisar: warn chama atenção
    // sem ser falha do bot.
    if (toReview) log.warn(formatBootTable(entries), fields);
    else log.info(formatBootTable(entries), fields);
  }

  // `^0.0.z` aceita só `0.0.z`: o dependente para de carregar no primeiro bump de patch da
  // dependência, mesmo sem quebra. Aviso, não erro: a faixa é válida e pode ser intencional.
  function warnExactCaret(definition: PluginDefinition): void {
    const fields = [
      ['dependsOn', definition.dependsOn],
      ['optionalDependsOn', definition.optionalDependsOn],
    ] as const;
    for (const [label, dependencies] of fields) {
      for (const [dependency, range] of Object.entries(dependencies ?? {})) {
        if (!isExactCaret(range)) continue;
        log.warn(
          `plugin "${definition.name}": ${label}["${dependency}"] = "${range}" aceita só essa ` +
            'versão exata; para acompanhar o 0.x da dependência, use "0.x" ou ">=0.0.0 <1.0.0"',
          { plugin: definition.name, dependency, range },
        );
      }
    }
  }

  // Provedor opcional fora da faixa não impede a carga (ADR 0099): o serviço dele já está no
  // registry quando o dependente sobe, e esconder do `has` só para um plugin criaria um segundo
  // estado de serviço. Fica o aviso, uma vez no boot, porque as versões não mudam em runtime.
  function warnOptionalVersion(definition: PluginDefinition): void {
    for (const [dependency, range] of Object.entries(definition.optionalDependsOn ?? {})) {
      const version = byName.get(dependency)?.entry.definition.version;
      if (version === undefined || satisfies(version, range)) continue;
      log.warn(
        `plugin "${definition.name}": optionalDependsOn["${dependency}"] = "${range}" não ` +
          `aceita a versão carregada ${version}; o plugin sobe e o serviço dela segue visível`,
        { plugin: definition.name, dependency, range, version },
      );
    }
  }

  /** Erros de boot: manifesto, nome repetido e ciclo. Lança antes de qualquer setup. */
  function plan(): Slot[] {
    const origins = new Map<string, string[]>();
    for (const { definition, origin } of options.plugins) {
      assertPluginDefinition(definition, origin);
      origins.set(definition.name, [...(origins.get(definition.name) ?? []), origin]);
    }
    for (const [name, found] of origins) {
      if (found.length > 1) throw new PluginConflictError(name, found);
    }
    const order = sortPlugins(options.plugins.map((entry) => entry.definition));
    const entryOf = new Map(options.plugins.map((entry) => [entry.definition, entry]));
    return order.map((definition) => {
      const entry = entryOf.get(definition) as PluginEntry;
      return { entry, report: { ...reportBase(entry), status: 'loaded' }, handle: undefined };
    });
  }

  async function runStart(): Promise<PluginReportEntry[]> {
    try {
      slots = plan();
    } catch (error) {
      state = 'stopped';
      throw error;
    }
    for (const slot of slots) byName.set(slot.entry.definition.name, slot);
    for (const name of disabled) {
      if (!byName.has(name)) {
        log.warn(`disabledPlugins cita "${name}", que não existe entre os plugins`, {
          plugin: name,
        });
      }
    }
    for (const slot of slots) {
      warnExactCaret(slot.entry.definition);
      warnOptionalVersion(slot.entry.definition);
    }
    for (const slot of slots) {
      const reason = incompatibility(slot.entry.definition);
      slot.report = reason
        ? { ...reportBase(slot.entry), status: 'skipped', reason }
        : await bringUp(slot);
    }
    const table = slots.map((slot) => slot.report);
    logTable(table);
    if (state === 'starting') state = 'running';
    return table;
  }

  async function runStop(signal?: AbortSignal): Promise<PluginLifecycleError[]> {
    state = 'stopping';
    const errors: PluginLifecycleError[] = [];
    // Ordem inversa: quem subiu depois pode usar serviços de quem subiu antes.
    for (const slot of slots.toReversed()) errors.push(...(await bringDown(slot, signal)));
    state = 'stopped';
    return errors;
  }

  function slotOf(action: string, name: string): Slot {
    if (state !== 'running') {
      throw new PluginHostStateError(`${action}("${name}"): host em "${state}"`);
    }
    const slot = byName.get(name);
    if (!slot) throw new PluginHostStateError(`${action}("${name}"): plugin desconhecido`);
    return slot;
  }

  async function runReload(name: string): Promise<PluginChangeResult> {
    const slot = slotOf('reload', name);
    const { report } = slot;
    if (report.status === 'skipped' && report.reason.kind !== 'setup-failed') {
      throw new PluginHostStateError(
        `reload("${name}"): plugin ignorado (${describeSkipReason(report.reason)}); ` +
          'só recarrega plugin carregado ou cujo setup falhou',
      );
    }
    return restart(slot, 'recarregado');
  }

  async function runDisable(name: string): Promise<PluginChangeResult> {
    const slot = slotOf('disable', name);
    if (disabled.has(name)) return { plugin: slot.report, dependents: [], teardownErrors: [] };
    disabled.add(name);
    return restart(slot, 'desligado');
  }

  async function runEnable(name: string): Promise<PluginChangeResult> {
    const slot = slotOf('enable', name);
    if (!disabled.delete(name)) return { plugin: slot.report, dependents: [], teardownErrors: [] };
    return restart(slot, 'ligado');
  }

  /**
   * Desce o plugin e os dependentes e sobe de novo, na ordem do boot. Todos passam por
   * `incompatibility`, inclusive a raiz: o motivo dela pode ter mudado (desligada, ou com a
   * dependência desligada), e um `setup-failed` anterior ganha nova tentativa.
   */
  async function restart(slot: Slot, verb: string): Promise<PluginChangeResult> {
    const name = slot.entry.definition.name;
    // Quem guardou um serviço do plugin no `setup` ficaria com a instância do contexto
    // descartado: o subgrafo de dependentes desce e sobe junto (ADR 0041).
    const affected = withDependents(slot);
    const errors: PluginLifecycleError[] = [];
    for (const each of affected.toReversed()) errors.push(...(await bringDown(each)));
    for (const each of affected) {
      const reason = incompatibility(each.entry.definition);
      each.report = reason
        ? { ...reportBase(each.entry), status: 'skipped', reason }
        : await bringUp(each);
    }
    const dependents = affected.slice(1).map((each) => each.report);
    log.info(
      `plugin "${name}" ${verb}: ${slot.report.status === 'loaded' ? 'carregado' : 'ignorado'}`,
      {
        plugin: name,
        status: slot.report.status,
        ...(dependents.length > 0 && {
          dependents: dependents.map((entry) => ({ name: entry.name, status: entry.status })),
        }),
      },
    );
    return { plugin: slot.report, dependents, teardownErrors: errors };
  }

  /**
   * O slot e quem depende dele por `dependsOn` ou `optionalDependsOn`, direta ou
   * transitivamente, na ordem de carga. `after` só ordena: quem o usa não pega nada do outro
   * plugin, então não entra. O opcional entra porque o setup dele decide o que registra conforme
   * o serviço existe (ADR 0099).
   */
  function withDependents(root: Slot): Slot[] {
    const names = new Set([root.entry.definition.name]);
    // Na ordem topológica, toda dependência aparece antes do dependente: uma passada basta.
    return slots.filter((each) => {
      if (each === root) return true;
      const { definition } = each.entry;
      const dependsOn = [
        ...Object.keys(definition.dependsOn ?? {}),
        ...Object.keys(definition.optionalDependsOn ?? {}),
      ];
      if (!dependsOn.some((dependency) => names.has(dependency))) return false;
      names.add(each.entry.definition.name);
      return true;
    });
  }

  return {
    get state(): PluginHostState {
      return state;
    },

    start(): Promise<PluginReportEntry[]> {
      if (state !== 'idle') {
        return Promise.reject(new PluginHostStateError(`start(): host em "${state}"`));
      }
      state = 'starting';
      return enqueue(runStart);
    },

    stop(signal?: AbortSignal): Promise<PluginLifecycleError[]> {
      if (state === 'idle') {
        state = 'stopped';
        stopPromise = Promise.resolve([]);
      }
      stopPromise ??= enqueue(() => runStop(signal));
      return stopPromise;
    },

    reload(name: string): Promise<PluginChangeResult> {
      return enqueue(() => runReload(name));
    },

    disable(name: string): Promise<PluginChangeResult> {
      return enqueue(() => runDisable(name));
    },

    enable(name: string): Promise<PluginChangeResult> {
      return enqueue(() => runEnable(name));
    },

    report(): PluginReportEntry[] {
      return slots.map((slot) => slot.report);
    },
  };
}
