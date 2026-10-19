// Controle dos plugins em execução (`bot.plugins`, `bot.config`): reload/disable/enable e a
// situação de cada plugin na tabela do host. O host e as configs nascem só no boot, por isso
// chegam por getters.
import type { CommandCatalog } from '#commands/catalog.ts';
import type { PluginConfigs } from '#config/plugin-configs.ts';
import type { ConversationRegistry, PluginPresence } from '#conversations/conversations.ts';
import type { PluginChangeResult, PluginHost } from '#plugin/host.ts';
import type { PluginLifecycleError, PluginReportEntry } from '#plugin/report.ts';
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
}

export interface PluginControl {
  readonly plugins: BotPlugins;
  readonly config: BotPluginConfigs;
  /** Situação do plugin na tabela do host, para a varredura das esperas persistidas (ADR 0094). */
  presence(plugin: string): PluginPresence;
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

  const plugins: BotPlugins = Object.defineProperties(
    Object.assign((): PluginReportEntry[] => deps.host()?.report() ?? [], {
      reload: (name: string) => change('reload', name),
      disable: (name: string) => change('disable', name),
      enable: (name: string) => change('enable', name),
    }),
    { bootedAt: { get: () => deps.host()?.bootedAt, enumerable: true } },
  ) as BotPlugins;

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

  const config: BotPluginConfigs = {
    setOverrides: (plugin, overrides) =>
      requireConfigs('setOverrides').setOverrides(plugin, overrides),
    setSecret: (plugin, path, value) => requireConfigs('setSecret').setSecret(plugin, path, value),
    clearSecret: (plugin, path) => requireConfigs('clearSecret').clearSecret(plugin, path),
    get secretsWritable() {
      return requireConfigs('secretsWritable').secretsWritable;
    },
    describe: (plugin) => requireConfigs('describe').describe(plugin),
    jsonSchema: (plugin) => requireConfigs('jsonSchema').jsonSchema(plugin),
  };

  return { plugins, config, presence };
}
