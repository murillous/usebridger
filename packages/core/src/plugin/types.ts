// Contrato do plugin (ADR 0016): manifesto, definição e o contexto que `setup` recebe. O M1-8
// implementa `definePlugin`, a validação e o lifecycle; quem monta o `PluginContext` é o `Bot`
// (M1-16). Os campos do contexto vêm dos contratos de cada módulo.

import type { z } from 'zod';
import type { BotStats } from '#bot/config.ts';
import type {
  AcceptSpec,
  CommandContextFor,
  CommandDefinition,
  CommandInfo,
  CommandRejection,
  RejectContext,
} from '#commands/command.ts';
import type { Prefixes } from '#commands/prefixes.ts';
import type { RoleCheck, RoleName } from '#commands/roles.ts';
import type { Conversations } from '#conversations/conversations.ts';
import type { BotEventName, EventSubscriber, ListenerContext } from '#events/types.ts';
import type { Groups } from '#groups/groups.ts';
import type { HttpRoutes } from '#http/types.ts';
import type { Logger } from '#logger/types.ts';
import type { Contact, Message } from '#message/types.ts';
import type { Observer, ObserverSignalName } from '#observers/observers.ts';
import type { Outbound } from '#outbound/types.ts';
import type { Scheduler } from '#scheduler/types.ts';
import type { ServiceAccess } from '#services/types.ts';
import type { PluginContextStorage } from '#storage/tenant.ts';
import type { Capability } from '#transport/capabilities.ts';
import type { ConnectionStatus, Unsubscribe } from '#transport/types.ts';
import type { Unsafe } from '#unsafe/types.ts';

/** Textos ao usuário, sobrescrevíveis pela config (ADR 0025). */
export type PluginMessages = Readonly<Record<string, string>>;

export interface PluginManifest {
  /** Único no bot; usado em enable/disable, logs, namespace de storage e rotas. */
  readonly name: string;
  readonly version: string;
  /** Faixa semver do `@usebridger/core` com que o plugin funciona. */
  readonly engine: string;
  /** Capabilities do transport sem as quais o plugin não carrega. */
  readonly requires?: readonly Capability[];
  /** Fixa o(s) transport(s) por nome; ausente = qualquer um que tenha as `requires`. */
  readonly transports?: readonly string[];
  /** Plugins de que este depende: nome → faixa semver. Carregam antes deste. */
  readonly dependsOn?: Readonly<Record<string, string>>;
  /** Maior carrega antes. Padrão: 0. */
  readonly priority?: number;
  /** Carrega depois destes, sem exigir que existam. */
  readonly after?: readonly string[];
  /**
   * Plugins de que este usa serviços opcionais (ADR 0099): nome → faixa semver, como no
   * `dependsOn`. Carregam antes deste, mas sem impedir a carga se estiverem ausentes, ignorados,
   * desligados ou fora da faixa (aí o boot avisa em `warn`); recarregar, desligar ou ligar um
   * deles recarrega este em cascata. É o par do `services` do comando: o comando que exige o
   * serviço some e volta com o provedor.
   */
  readonly optionalDependsOn?: Readonly<Record<string, string>>;
}

/** O que o plugin recebe em `setup`/`teardown`. */
export interface PluginContext<
  TConfig = unknown,
  TMessages extends PluginMessages = PluginMessages,
> {
  readonly plugin: {
    readonly name: string;
    readonly version: string;
    /** `messages` do plugin já mesclado com o que a config sobrescreveu. */
    readonly messages: TMessages;
  };
  /** Config validada pelo schema do plugin (M1-13). */
  readonly config: TConfig;
  /** Logger com `plugin` no contexto (M1-14). */
  readonly log: Logger;
  /**
   * Aborta quando o contexto é descartado: no `teardown`/reload, ou quando o `setup` falha ou
   * estoura o prazo (`reason` = o erro do `setup`). Repasse ao trabalho de fundo do plugin
   * (ADR 0033). Descartado o contexto, `send` (com as ações), `groups`, `storage` e
   * `scheduler.at`/`cancel` rejeitam com `ContextExpiredError`.
   */
  readonly signal: AbortSignal;
  readonly commands: {
    add(definition: CommandDefinition): void;
    /** Comandos registrados por todos os plugins carregados, na ordem de registro (ADR 0040). */
    list(): CommandInfo[];
    /**
     * Só os comandos que o remetente de `for` passa no papel, com a regra do roteador: owner
     * passa em todos, e erro, prazo ou papel sem dono recusam. O `check` de papel custom recebe
     * o texto original da mensagem. Não confere `accepts`. Nunca rejeita.
     */
    list(options: { readonly for: Message }): Promise<CommandInfo[]>;
  };
  /**
   * Papéis custom (ADR 0035): `define('moderador', check)` deixa qualquer plugin exigir
   * `role: 'moderador'`. O nome vem de `Roles` (declaration merging). Nome reservado lança
   * `TypeError`; nome que já tem dono, `RoleConflictError`. O papel sai no teardown/reload.
   */
  readonly roles: { define<K extends RoleName>(name: K, check: RoleCheck): void };
  /**
   * Prefixo de comando por chat (ADR 0063): `get(chat)` dá o que vale no chat (para mostrar
   * `!ajuda` certo), `set(chatId, prefixo)` grava o override e `reset(chatId)` volta ao padrão do
   * tipo de chat. O override vale para o bot inteiro, não só para o plugin.
   */
  readonly prefixes: Prefixes;
  /**
   * Passos de conversa (ADR 0060): `define('aluno', handler)` trata a resposta que um comando,
   * listener ou passo pediu com `ctx.expectReply('aluno')`, sem segurar o chat.
   */
  readonly conversations: Conversations;
  readonly events: EventSubscriber;
  readonly services: ServiceAccess;
  /**
   * Storage do plugin. Numa mensagem ou evento de chat com `tenantId`, e em tudo o que o handler
   * dispara, vale o namespace daquele tenant; fora dele (`setup`, timer solto, job sem tenant),
   * o da sessão, compartilhado entre tenants. `forTenant(id)` escolhe um tenant à mão (ADR 0072).
   * `shared` é o comum a todas as sessões no mesmo storage, também por tenant (ADR 0075).
   */
  readonly storage: PluginContextStorage;
  readonly scheduler: Scheduler;
  /**
   * Envio e ações sobre mensagens e chats (`react`, `edit`, `delete`, `typing`), todos pela
   * fila de saída (ADR 0040).
   */
  readonly send: Outbound;
  /** Metadados e participantes de grupo (ADR 0040). */
  readonly groups: Groups;
  /**
   * Rotas HTTP e WebSocket do plugin sob `/plugins/<nome>` (ADR 0076). Sem `http` na config do
   * bot, `route` e `ws` lançam `BotConfigError` (o plugin cai no `setup`).
   */
  readonly http: HttpRoutes;
  /**
   * O que o transport suporta. Para recurso opcional: confira aqui em vez de exigir em
   * `requires` (ex.: reagir se der, responder em texto se não).
   */
  readonly capabilities: ReadonlySet<Capability>;
  /**
   * `Transport.name` do bot (`baileys`, `web`...). IDs de contato e de chat só são únicos dentro
   * de um transport: no `ctx.storage.shared`, componha com ele a chave que vier de um ID.
   */
  readonly transportName: string;
  /** Nome da sessão do bot (`default` quando a config não o define); vários bots no processo se distinguem por ele. */
  readonly session: string;
  /**
   * Último `ConnectionStatus` que o transport emitiu, o mesmo do `connection.status` no
   * barramento (ADR 0110). `undefined` antes do primeiro evento. Serve a quem sobe depois do
   * boot (ou num reload) e não pode esperar o próximo evento.
   */
  connectionStatus(): ConnectionStatus | undefined;
  /** Contato da própria sessão; `null` até a primeira conexão aberta. */
  readonly self: Contact | null;
  /**
   * Contadores das filas de entrada e de saída deste bot, os mesmos de `bot.stats()` (ADR 0106).
   * Leitura O(1) e instantânea, para amostrar sob demanda: guarde a série no plugin. Devolve uma
   * cópia.
   */
  stats(): BotStats;
  /**
   * Observa um sinal do core (ADR 0106): `message.handled` quando o bot termina de tratar uma
   * mensagem, `outbound.sent` quando um envio sai da fila de saída. O observador é síncrono e
   * nunca aguardado: não segura o chat. A exceção dele vira `plugin.error` com
   * `phase: 'observer'`. A assinatura sai sozinha no dispose do plugin.
   */
  observe<S extends ObserverSignalName>(signal: S, observer: Observer<S>): Unsubscribe;
  readonly unsafe: Unsafe;
}

/**
 * Comando declarado no manifesto (ADR 0079): o `CommandDefinition` sem `name`, que vem da chave em
 * `commands`. O kernel o registra com `ctx.commands.add` antes do `setup`. `TAccepts` é o
 * `accepts` declarado, que o `definePlugin` infere para tipar o contexto do `run`.
 */
export interface PluginCommand<
  TConfig = unknown,
  TMessages extends PluginMessages = PluginMessages,
  TAccepts extends readonly AcceptSpec[] = readonly AcceptSpec[],
> extends Omit<CommandDefinition, 'name' | 'accepts' | 'run' | 'onReject'> {
  // Fora do `Omit` para o `definePlugin` inferir `TAccepts` daqui.
  readonly accepts?: TAccepts;
  // Sintaxe de método de propósito: parâmetro bivariante, para `PluginDefinition<Schema>` caber
  // na anotação larga `: PluginDefinition` que o `isolatedDeclarations` exige.
  /**
   * O `run` do comando, com o contexto do plugin (`storage`, `config`, `send`...) no 2º
   * argumento. Devolver texto responde, como em qualquer comando.
   */
  run(
    ctx: CommandContextFor<TAccepts, keyof TMessages & string>,
    plugin: PluginContext<TConfig, TMessages>,
  ): unknown;
  /**
   * O `onReject` do comando, com o contexto do plugin no 3º argumento: a recusa pode usar
   * `plugin.plugin.messages`, que a config sobrescreve (ADR 0025).
   */
  onReject?(
    ctx: RejectContext<keyof TMessages & string>,
    rejection: CommandRejection,
    plugin: PluginContext<TConfig, TMessages>,
  ): ReturnType<NonNullable<CommandDefinition['onReject']>>;
}

/** Listener declarado no manifesto: o de `ctx.events.on`, com o contexto do plugin no 2º argumento. */
export type PluginListener<
  E extends BotEventName,
  TConfig = unknown,
  TMessages extends PluginMessages = PluginMessages,
> = {
  // Truque do método, como no `PluginCommand.run`: tipo de função com parâmetro bivariante.
  listener(ctx: ListenerContext<E>, plugin: PluginContext<TConfig, TMessages>): unknown;
}['listener'];

/** `on` do manifesto: um listener por evento. Mais de um, prioridade ou filtro: `setup`. */
export type PluginListeners<
  TConfig = unknown,
  TMessages extends PluginMessages = PluginMessages,
> = { readonly [E in BotEventName]?: PluginListener<E, TConfig, TMessages> };

/**
 * `accepts` de cada comando do manifesto, nome → lista, inferido pelo `definePlugin`. O comando
 * sem `accepts` não dá o que inferir e fica `unknown`, que `AcceptsOf` troca pela lista larga.
 */
export type PluginAccepts = Readonly<Record<string, unknown>>;

type AcceptsOf<T> = T extends readonly AcceptSpec[] ? T : readonly AcceptSpec[];

export interface PluginDefinition<
  TSchema extends z.ZodType = z.ZodType,
  TMessages extends PluginMessages = PluginMessages,
  TAccepts extends PluginAccepts = PluginAccepts,
> extends PluginManifest {
  /** Schema Zod da config (ADR 0017). */
  readonly config?: TSchema;
  readonly messages?: TMessages;
  /**
   * Comandos fixos, nome → definição (ADR 0079). Ficam conhecidos sem rodar o plugin, e o kernel
   * os registra antes do `setup`. Declará-los implica `requires: ['send.text']`.
   */
  readonly commands?: {
    readonly [K in keyof TAccepts]: PluginCommand<
      z.output<TSchema>,
      TMessages,
      AcceptsOf<TAccepts[K]>
    >;
  };
  /** Listeners fixos, evento → listener (ADR 0079), registrados antes do `setup`. */
  readonly on?: PluginListeners<z.output<TSchema>, TMessages>;
  /** O que é dinâmico: depende da config, registra sob condição, prepara estado. */
  setup?(ctx: PluginContext<z.output<TSchema>, TMessages>): void | Promise<void>;
  teardown?(ctx: PluginContext<z.output<TSchema>, TMessages>): void | Promise<void>;
}
