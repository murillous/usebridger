import type { PrefixConfig } from '#commands/prefixes.ts';
import type { ConfigEnv } from '#config/env.ts';
import type { BotOwner } from '#config/owners.ts';
import type { PluginConfigFile, PluginConfigs } from '#config/plugin-configs.ts';
import type { BotMessageContext } from '#context.ts';
import type { HttpServer } from '#http/types.ts';
import type { LoggerOptions } from '#logger/logger.ts';
import type { SecretSet } from '#logger/secrets.ts';
import type { LogFields, Logger, LogLevel } from '#logger/types.ts';
import type { ChatFilterOptions } from '#middleware/chat-filter.ts';
import type { Middleware } from '#middleware/pipeline.ts';
import type { RateLimitOptions } from '#middleware/rate-limit.ts';
import type { SanitizeOptions } from '#middleware/sanitize.ts';
import type { OutboundQueueOptions, OutboundQueueStats } from '#outbound/queue.ts';
import type { PluginChangeResult } from '#plugin/host.ts';
import type { PluginReportEntry } from '#plugin/report.ts';
import type { PluginDefinition } from '#plugin/types.ts';
import type { InboundQueueOptions, InboundQueueStats } from '#queue/inbound.ts';
import type { StoragePort } from '#storage/types.ts';
import type { Transport, TransportDeps } from '#transport/types.ts';
import type { BotReconnectionOptions } from './reconnect.ts';
import type { ShutdownOptions, StopHook, StopHookOptions } from './stop-hooks.ts';

/**
 * Ciclo de vida: `idle → starting → running → stopping → stopped`. `stopped` é terminal —
 * uma instância não reinicia; para subir de novo, crie outro `Bot`.
 *
 * `failed` (ADR 0116): a reconexão desistiu (erro `fatal`, credencial rejeitada, `replaced`,
 * sessão a parear sem `clearSession`). Transport e filas estão parados; plugins e HTTP seguem no
 * ar para o painel mostrar o erro. `start()` rejeita (não reinicia) e `stop()` chega a `stopped`.
 */
export type BotState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

/** Middleware do app com prioridade (maior roda antes). */
export interface BotMiddlewareEntry {
  readonly middleware: Middleware<BotMessageContext>;
  /** Padrão: 0 — dentro dos oficiais, que ficam entre 700 e 1000. */
  readonly priority?: number;
}

/**
 * Middlewares do bot. Os oficiais entram nesta ordem (de fora para dentro): `ignoreSelf` (1000),
 * `ignoreBots` (990), `chatFilter` (900), `rateLimit` (800), `sanitize` (700); depois os do app
 * (`use`, padrão 0).
 */
export interface BotMiddlewaresConfig {
  /** Barra as mensagens da própria sessão. Padrão: `true`. */
  readonly ignoreSelf?: boolean;
  /** Barra as mensagens de outros bots (`sender.isBot`). Padrão: `true`. */
  readonly ignoreBots?: boolean;
  /** Allow/blocklist de chats. Padrão: desligado. */
  readonly chatFilter?: ChatFilterOptions;
  /** Rate limit de entrada. Padrão: desligado. Sem `onLimited`, loga em `debug`. */
  readonly rateLimit?: RateLimitOptions;
  /** Truncagem de texto e nome. Padrão: ligado com os limites do `sanitize`; `false` desliga. */
  readonly sanitize?: SanitizeOptions | false;
  /** Middlewares do app. */
  readonly use?: readonly (Middleware<BotMessageContext> | BotMiddlewareEntry)[];
}

/** Prazos dos estágios que rodam código de plugin, em ms. */
export interface BotTimeouts {
  /** Criação do contexto e `setup` de cada plugin. Padrão: 10000. */
  readonly setupMs?: number;
  /** `teardown` e limpeza de cada plugin. Padrão: 5000. */
  readonly teardownMs?: number;
  /**
   * `run` de cada comando; estourado, o chat é liberado e sai `plugin.error`. Padrão: 30000.
   * O `timeoutMs` de um comando sobrescreve só para ele.
   */
  readonly commandMs?: number;
  /** Cada listener de evento. Padrão: 30000. */
  readonly listenerMs?: number;
  /** Cada handler de job do scheduler. Padrão: 30000. */
  readonly jobMs?: number;
  /**
   * Cada middleware do pipeline, contado só no tempo dele (o que roda dentro do `next()` não
   * conta). Estourado, a mensagem é descartada e o erro vai para o log. Padrão: 30000.
   */
  readonly middlewareMs?: number;
}

export interface BotConfig {
  /**
   * O transport, ou a fábrica que o monta com o que o bot fornece (`session`, `auth`, `log`;
   * ADR 0033). O `createBot` chama a fábrica uma vez; ela só monta o objeto, sem I/O.
   */
  readonly transport: Transport | ((deps: TransportDeps) => Transport);
  /**
   * Sessão (o número) que este bot opera; kebab-case, como nome de plugin. Tudo o que o bot
   * persiste fica no escopo dela (ADR 0032), então trocar o nome "esquece" os dados da anterior.
   * Dois bots vivos no mesmo storage não podem usar a mesma. Padrão: `'default'`.
   */
  readonly session?: string;
  /**
   * Nome de exibição do bot (ex.: `luma`), mostrado pelo dashboard. Só rótulo: não entra em
   * storage nem em chave. Padrão: o `Transport.name` (ADR 0111).
   */
  readonly name?: string;
  /**
   * Storage do bot (plugins, scheduler, overrides de config). O bot o fecha no `stop()` — o
   * último a parar, se vários bots o dividem. Padrão: em memória (`createMemoryStorage`), com
   * aviso no log — os dados somem ao reiniciar.
   */
  readonly storage?: StoragePort;
  /**
   * Servidor HTTP do processo (`createHttp`), o mesmo para todos os bots (ADR 0072). Dá
   * `ctx.http` aos plugins e `TransportDeps.http` ao transport; a porta só abre se houver rota.
   */
  readonly http?: HttpServer;
  /** Plugins da config (pacotes npm que o app importa). */
  readonly plugins?: readonly PluginDefinition[];
  /** Pastas de plugins locais (ver `collectPlugins`), relativas a `cwd`. */
  readonly pluginDirs?: readonly string[];
  /** Base de `pluginDirs`. Padrão: `process.cwd()`. */
  readonly cwd?: string;
  /** Nomes de plugin que não carregam. */
  readonly disabledPlugins?: readonly string[];
  /**
   * Nomes de plugin que recebem `ctx.admin` (ADR 0107). Lista no `createBot`, e não no manifesto:
   * quem decide é o dono do app, não o plugin que ganharia o poder.
   */
  readonly adminPlugins?: readonly string[];
  /** Config por plugin (a camada "arquivo"; ver ADR 0028). */
  readonly pluginConfig?: PluginConfigFile;
  /** Ambiente da config de plugin (`BRIDGER_*`). Padrão: `process.env`. */
  readonly env?: ConfigEnv;
  /**
   * Donos (`role: 'owner'`): telefone, aceito com pontuação e normalizado no `createBot`, ou
   * `{ id }` com o ID nativo do contato, para plataformas sem telefone.
   */
  readonly owners?: readonly BotOwner[];
  /**
   * Prefixo de comando: um para todo chat (`'!'`) ou um por tipo (`{ dm: '', group: '!' }`,
   * `group` vale para todo chat que não é `dm`). Vazio é permitido. Padrão: `'!'`. Um plugin
   * troca o de um chat com `ctx.prefixes.set` (ADR 0059).
   */
  readonly prefix?: PrefixConfig;
  /**
   * Logger pronto. Sem ele, o bot cria um (`createLogger`) com `logLevel` e `secrets`. Um
   * logger próprio só censura os segredos da config se for criado com o mesmo `secrets`.
   */
  readonly logger?: Logger;
  /**
   * Campos em toda linha de log do bot (ADR 0118), além do `bot` (a `session`), que o bot põe
   * sozinho. Para o agregador saber de onde veio a linha: `{ service: 'lumabot', version, env }`.
   * O core não lê variável de ambiente nem o `package.json` do app: quem sabe é o app.
   */
  readonly logBindings?: LogFields;
  /** Nível do logger criado pelo bot. Padrão: `'info'`. */
  readonly logLevel?: LogLevel;
  /**
   * Formato do logger criado pelo bot: `'json'` (padrão) ou `'pretty'`, legível no terminal
   * (ver `LoggerOptions.format`).
   */
  readonly logFormat?: LoggerOptions['format'];
  /** Fonte de segredos compartilhada entre a config de plugin e o logger. Padrão: uma nova. */
  readonly secrets?: SecretSet;
  readonly middlewares?: BotMiddlewaresConfig;
  /** Fila de entrada por chat. */
  readonly inbound?: Pick<InboundQueueOptions, 'maxPendingPerChat'>;
  /** Fila de saída (taxa, prioridade, retry, humanização). */
  readonly outbound?: Omit<OutboundQueueOptions, 'transport' | 'observers'>;
  /** Reconexão automática. Padrão: ligada com os padrões da `ReconnectionPolicy`. */
  readonly reconnection?: BotReconnectionOptions | false;
  readonly timeouts?: BotTimeouts;
  readonly shutdown?: ShutdownOptions;
}

/** Config de plugin em runtime, para o dashboard: overrides, visão mascarada e schema. */
export type BotPluginConfigs = Pick<
  PluginConfigs,
  'setOverrides' | 'setSecret' | 'clearSecret' | 'secretsWritable' | 'describe' | 'jsonSchema'
>;

/**
 * Controle dos plugins que `ctx.admin` dá aos listados em `adminPlugins` (ADR 0107): delega às
 * instâncias de `bot.plugins` e `bot.config`. Só duas diferenças: sobre o próprio plugin,
 * `plugins.reload`/`disable` e `config.setOverrides` rejeitam (o plugin desceria no meio da
 * própria chamada); e as ações que mudam estado rejeitam com `ContextExpiredError` depois do
 * `dispose` do plugin (ADR 0029).
 */
export interface PluginAdmin {
  readonly plugins: BotPlugins;
  readonly config: BotPluginConfigs;
}

export interface Bot {
  readonly state: BotState;
  /**
   * Sobe o bot (ordem em docs/bot.md): carrega os plugins e, só se o boot deles der certo,
   * conecta o transport e liga o scheduler. Plugin quebrado (ex.: `CommandConflictError`) ⇒ o
   * transport nunca conecta. Idempotente enquanto `starting`/`running` (devolve a mesma
   * promise); rejeita com `BotStateError` depois de `stop()`. Rejeita com o erro de boot depois
   * de encerrar o que já tinha subido.
   */
  start(): Promise<void>;
  /**
   * Shutdown gracioso: roda os ganchos de parada (LIFO; os internos drenam filas e fazem o
   * `teardown` dos plugins), desconecta o transport e fecha o storage. Idempotente: chamadas
   * repetidas devolvem a mesma promise. Rejeita com `AggregateError` se alguma etapa falhar —
   * mas sempre termina em `stopped`.
   */
  stop(): Promise<void>;
  /** Registra um gancho de parada; devolve a função que o remove. */
  onStop(hook: StopHook, options?: StopHookOptions): () => void;
  /** Config dos plugins. Disponível depois que o `start()` carrega os plugins. */
  readonly config: BotPluginConfigs;
  /** Tabela de boot atual (reflete reloads); vazia antes do `start()`. Também tem os métodos abaixo. */
  readonly plugins: BotPlugins;
  /**
   * Métricas das filas de entrada e de saída, lidas de contadores (O(1)). Sempre disponível:
   * zeros antes do `start()`, valores finais depois do `stop()`. Devolve uma cópia.
   */
  stats(): BotStats;
  /**
   * Resolve quando o bot terminou de processar o que recebeu: fila de entrada vazia, nenhum
   * comando em segundo plano (ADR 0083) nem listener em andamento (inclusive de eventos diretos e
   * `plugin.error`) e fila de saída vazia, tudo ao mesmo tempo (ADR 0040). Chamado durante o boot, espera o boot assentar. Não
   * espera jobs do scheduler; com a fila de saída pausada (conexão caída), espera a reconexão ou
   * o `maxPauseMs`. Resolve na hora antes do `start()` e depois do `stop()`; nunca rejeita.
   */
  settled(): Promise<void>;
}

/**
 * Plugins em execução. Chamado, devolve a tabela de boot (`PluginReportEntry[]`); os métodos
 * mudam um plugin sem mexer na config (sem gravar override no storage). Quem muda um plugin
 * recebe o mesmo `PluginChangeResult` do reload por config: a linha nova do plugin
 * (`plugin`), a dos dependentes (`dependents`) e as falhas de teardown (`teardownErrors`).
 * Quem não estiver `start()`-ado recebe `BotStateError`; plugin desconhecido, `PluginHostStateError`.
 */
export interface BotPlugins {
  (): PluginReportEntry[];
  /** Epoch ms em que o boot dos plugins terminou; `undefined` antes do `start()`. Reload não o muda. */
  readonly bootedAt: number | undefined;
  /** Derruba e sobe de novo o plugin e os dependentes (ADR 0037). */
  reload(name: string): Promise<PluginChangeResult>;
  /** Desliga o plugin e os dependentes, que viram `dependency-skipped`; até `enable`. */
  disable(name: string): Promise<PluginChangeResult>;
  /** Liga um plugin desligado (`disable` ou `disabledPlugins`); sobem os dependentes que ele libera. */
  enable(name: string): Promise<PluginChangeResult>;
}

export interface BotStats {
  readonly inbound: InboundQueueStats;
  readonly outbound: OutboundQueueStats;
}

/** Operação incompatível com o estado atual do bot. */
export class BotStateError extends Error {
  readonly state: BotState;

  constructor(message: string, state: BotState) {
    super(message);
    this.name = 'BotStateError';
    this.state = state;
  }
}
