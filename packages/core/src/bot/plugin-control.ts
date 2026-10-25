// Controle dos plugins em execução (`bot.plugins`, `bot.config`): reload/disable/enable e a
// situação de cada plugin na tabela do host. O host e as configs nascem só no boot, por isso
// chegam por getters.
import type { Audit } from '#audit/audit.ts';
import { currentAuditSubject } from '#audit/scope.ts';
import type { AuditActor } from '#audit/types.ts';
import type { CommandCatalog } from '#commands/catalog.ts';
import type { PluginConfigs } from '#config/plugin-configs.ts';
import type { ConversationRegistry, PluginPresence } from '#conversations/conversations.ts';
import * as LOG from '#logger/events.ts';
import type { Logger } from '#logger/types.ts';
import type { PluginChangeResult, PluginHost } from '#plugin/host.ts';
import type { PluginLifecycleError, PluginReportEntry } from '#plugin/report.ts';
import type { JsonObject, JsonValue } from '#storage/types.ts';
import type { BotPluginConfigs, BotPlugins, BotState } from './config.ts';
import { BotStateError } from './config.ts';
import type { ExpireOrigin, KernelMessageContext } from './message-context.ts';

export interface PluginControlDeps {
  /** Nasce no `bootPlugins`. */
  readonly host: () => PluginHost | undefined;
  readonly configs: () => PluginConfigs | undefined;
  /** Só para a mensagem do `BotStateError`. */
  readonly state: () => BotState;
  readonly catalog: Pick<CommandCatalog, 'batch'>;
  readonly conversations: Pick<ConversationRegistry<KernelMessageContext, ExpireOrigin>, 'sweep'>;
  readonly lifecycleError: (error: PluginLifecycleError) => void;
  /** Auditoria das ações do kernel (ADR 0122); sem ela nada é gravado. */
  readonly audit?: Pick<Audit, 'record'>;
  /** Para registrar a falha de leitura do diff de config. */
  readonly log?: () => Logger;
}

export interface PluginControl {
  readonly plugins: BotPlugins;
  readonly config: BotPluginConfigs;
  /** Situação do plugin na tabela do host, para a varredura das esperas persistidas (ADR 0094). */
  presence(plugin: string): PluginPresence;
  /** Mesmo controle com as ações auditadas em nome de `actor` (o plugin admin do `ctx.admin`). */
  as(actor: AuditActor): { readonly plugins: BotPlugins; readonly config: BotPluginConfigs };
}

/**
 * Folhas do objeto por caminho (`a.b`); array e valor simples são folhas.
 * shortcut: o join por `.` colide com chave que já contém ponto; trocar por caminho em array se
 * algum schema de plugin precisar disso.
 */
function leaves(value: unknown, prefix = '', out: Record<string, JsonValue> = {}) {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, each] of Object.entries(value)) leaves(each, `${prefix}${key}.`, out);
  } else if (prefix !== '') {
    // JSON ida e volta: o `record` recusa o que não é JSON, e a auditoria não pode derrubar a ação.
    out[prefix.slice(0, -1)] = (JSON.parse(JSON.stringify(value ?? null)) ?? null) as JsonValue;
  }
  return out;
}

/** Diff por caminho entre duas configs já mascaradas (campos `secret` no `SECRET_MASK`). */
function diffConfig(before: unknown, after: unknown): JsonObject {
  const a = leaves(before);
  const b = leaves(after);
  const diff: Record<string, JsonValue> = {};
  for (const path of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[path]) !== JSON.stringify(b[path])) {
      diff[path] = { from: a[path] ?? null, to: b[path] ?? null };
    }
  }
  return diff;
}

export function createPluginControl(deps: PluginControlDeps): PluginControl {
  function presence(plugin: string): PluginPresence {
    const entry = deps
      .host()
      ?.report()
      .find((each) => each.name === plugin);
    if (entry === undefined) return 'absent';
    if (entry.status === 'loaded') return 'loaded';
    return entry.reason.kind === 'disabled' ? 'disabled' : 'down';
  }

  /** Mudança de um plugin em execução (`action` só entra na mensagem de erro). */
  async function change(
    action: 'reload' | 'disable' | 'enable',
    name: string,
  ): Promise<PluginChangeResult> {
    const host = deps.host();
    if (!host) {
      throw new BotStateError(`${action}("${name}"): plugins ainda não carregados`, deps.state());
    }
    // Um aviso só ao transport, no fim: no meio, os comandos do plugin saíram e não voltaram.
    const result = await deps.catalog.batch(() => host[action](name));
    // O reload que redefiniu o passo fica com as esperas persistidas, e o `setup` novo que falhou
    // também (dormentes); o `disable` e o passo que sumiu as perdem, também do storage (ADR 0094).
    deps.conversations.sweep(presence);
    for (const error of result.teardownErrors) deps.lifecycleError(error);
    // Os dependentes recarregados em cascata (ADR 0037) também podem falhar no `setup` novo.
    for (const entry of [result.plugin, ...result.dependents]) {
      if (entry.status === 'skipped' && entry.reason.kind === 'setup-failed') {
        deps.lifecycleError(entry.reason.error);
      }
    }
    return result;
  }

  /** Roda `fn` e grava a ação do kernel: erro (ou `setup` novo que falhou) vira `outcome: error`. */
  async function audited<T>(
    actor: AuditActor | undefined,
    action: string,
    plugin: string,
    fn: () => Promise<T>,
    details: (ok: boolean) => JsonObject = () => ({}),
    failed: (result: T) => boolean = () => false,
  ): Promise<T> {
    const write = (outcome: 'success' | 'error', ok: boolean) =>
      deps.audit?.record({
        action,
        target: { type: 'plugin', id: plugin },
        outcome,
        details: { plugin, ...details(ok) },
        // Titular do escopo (`user`/`contact`, #223/#225) vence o ator explícito; ele sai com `via`.
        ...(actor && !currentAuditSubject() && { actor }),
      });
    let result: T;
    try {
      result = await fn();
    } catch (error) {
      write('error', false);
      throw error;
    }
    write(failed(result) ? 'error' : 'success', true);
    return result;
  }

  const setupFailed = (result: PluginChangeResult): boolean =>
    result.plugin.status === 'skipped' && result.plugin.reason.kind === 'setup-failed';

  function requireConfigs(method: string): PluginConfigs {
    const configs = deps.configs();
    if (!configs) {
      throw new BotStateError(
        `config.${method}(): plugins ainda não carregados (start)`,
        deps.state(),
      );
    }
    return configs;
  }

  /** Visão mascarada pelo schema. */
  async function view(plugin: string): Promise<unknown> {
    return (await requireConfigs('describe').describe(plugin)).config;
  }

  // Ler antes, aplicar e ler depois numa fila só: duas chamadas seguidas não misturam o diff,
  // e a ordem de aplicação é a da chamada.
  let overridesTail: Promise<unknown> = Promise.resolve();
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = overridesTail.then(task);
    overridesTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function make(actor?: AuditActor) {
    const plugins: BotPlugins = Object.defineProperties(
      Object.assign((): PluginReportEntry[] => deps.host()?.report() ?? [], {
        reload: (name: string) =>
          audited(
            actor,
            'kernel.plugin.reload',
            name,
            () => change('reload', name),
            undefined,
            setupFailed,
          ),
        disable: (name: string) =>
          audited(actor, 'kernel.plugin.disable', name, () => change('disable', name)),
        enable: (name: string) =>
          audited(
            actor,
            'kernel.plugin.enable',
            name,
            () => change('enable', name),
            undefined,
            setupFailed,
          ),
      }),
      { bootedAt: { get: () => deps.host()?.bootedAt, enumerable: true } },
    ) as BotPlugins;

    const config: BotPluginConfigs = {
      setOverrides: (plugin, overrides) => {
        // Síncrono como antes: sem plugins carregados lança `BotStateError` na hora.
        requireConfigs('setOverrides');
        let before: unknown;
        let after: unknown;
        let readFailed = false;
        const read = async (): Promise<unknown> => {
          try {
            return await view(plugin);
          } catch (err) {
            // A ação segue; o diff vira `null` em vez de comparar com uma leitura que não houve.
            readFailed = true;
            deps.log?.().event(LOG.auditConfigDiffFailed, { plugin, err });
            return undefined;
          }
        };
        return audited(
          actor,
          'kernel.config.update',
          plugin,
          () =>
            serialized(async () => {
              before = await read();
              const result = await requireConfigs('setOverrides').setOverrides(plugin, overrides);
              after = await read();
              return result;
            }),
          (ok) =>
            ok ? { changes: readFailed ? null : diffConfig(before, after) } : ({} as JsonObject),
        );
      },
      setSecret: (plugin, path, value) =>
        audited(
          actor,
          'kernel.secret.update',
          plugin,
          () => requireConfigs('setSecret').setSecret(plugin, path, value),
          () => ({ path, op: 'set' }),
        ),
      clearSecret: (plugin, path) =>
        audited(
          actor,
          'kernel.secret.update',
          plugin,
          () => requireConfigs('clearSecret').clearSecret(plugin, path),
          () => ({ path, op: 'clear' }),
        ),
      get secretsWritable() {
        return requireConfigs('secretsWritable').secretsWritable;
      },
      describe: (plugin) => requireConfigs('describe').describe(plugin),
      jsonSchema: (plugin) => requireConfigs('jsonSchema').jsonSchema(plugin),
    };
    return { plugins, config };
  }

  return { ...make(), presence, as: make };
}
