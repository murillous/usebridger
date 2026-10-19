import type { BotMessageContext } from '#context.ts';
import type { ExpectReply } from '#conversations/conversations.ts';
import type { Media, MediaMessageType, Message, MessageType } from '#message/types.ts';
import type { MessageText } from '#plugin/messages.ts';
import type { ServiceName } from '#services/types.ts';
import { type Capability, isCapability } from '#transport/capabilities.ts';
import type { RoleName } from './roles.ts';

/**
 * Quem pode rodar o comando: os embutidos (ADR 0021) ou um papel custom que um plugin define com
 * `ctx.roles.define` e declara em `Roles` (ADR 0031).
 */
export type CommandRole = 'owner' | 'group-admin' | 'everyone' | RoleName;

/** Entrada de `accepts` que só casa com mensagem que tem mídia. */
export type MediaAcceptSpec =
  | MediaMessageType
  | `quoted:${MediaMessageType}`
  | `${MediaMessageType}:${string}/${string}`
  | `quoted:${MediaMessageType}:${string}/${string}`;

/**
 * O que o comando aceita: o tipo da própria mensagem (`'image'`) ou da mensagem citada
 * (`'quoted:image'`). Um tipo com mídia pode restringir o mimetype depois de mais um `:`, exato
 * (`'document:application/pdf'`) ou com curinga no subtipo (`'quoted:video:video/*'`). `'args'`
 * casa quando há texto depois do comando: `'text'` casaria sempre, porque o próprio comando é
 * texto.
 */
export type AcceptSpec = MessageType | `quoted:${MessageType}` | MediaAcceptSpec | 'args';

/** Entrada de `accepts` decomposta. */
export interface ParsedAccept {
  readonly quoted: boolean;
  readonly type: string;
  /** Mimetype em minúsculas (`application/pdf`, `video/*`); `null` aceita qualquer um. */
  readonly mimetype: string | null;
}

/** Decompõe a entrada sem validar; a validação fica em `assertCommandDefinition`. */
export function parseAccept(spec: AcceptSpec): ParsedAccept {
  const quoted = spec.startsWith('quoted:');
  const rest = quoted ? spec.slice('quoted:'.length) : spec;
  const colon = rest.indexOf(':');
  if (colon === -1) return { quoted, type: rest, mimetype: null };
  return { quoted, type: rest.slice(0, colon), mimetype: rest.slice(colon + 1).toLowerCase() };
}

/**
 * O mimetype da mídia casa com o da entrada. Compara só a essência: `audio/ogg; codecs=opus`
 * casa com `audio/ogg`, porque os parâmetros variam por plataforma.
 */
export function mimetypeMatches(mimetype: string, pattern: string): boolean {
  const essence = mimetype.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (pattern.endsWith('/*')) return essence.startsWith(pattern.slice(0, -1));
  return essence === pattern;
}

// Só estes tipos têm `media`; a lista acompanha `MediaMessageType`.
const MEDIA_TYPES: ReadonlySet<string> = new Set<MediaMessageType>([
  'image',
  'video',
  'audio',
  'voice',
  'sticker',
  'document',
]);

/** `tipo/subtipo` ou `tipo/*`, nos caracteres que o RFC 6838 permite. */
const MIMETYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/;

/** Entrada de `accepts` que casou e a mensagem (própria ou citada) a que ela se refere. */
export interface AcceptedMessage {
  readonly spec: AcceptSpec;
  readonly message: Message;
}

/**
 * Contexto que o `run` recebe: o da mensagem (`text`, `reply`, `log`, montados pelo `Bot`) mais
 * o que o roteador resolveu. Quem usa o roteador fora do `Bot` fornece `reply`/`log` no
 * contexto passado a `dispatch`; o roteador só herda o que recebeu.
 */
export interface CommandContext<TKey extends string = string> extends BotMessageContext {
  /** Nome canônico do comando casado (não o alias digitado). */
  readonly command: string;
  /** Token digitado, já em minúsculas: o nome ou um dos aliases. */
  readonly invokedAs: string;
  /** Argumentos após o comando, com aspas resolvidas (ver `parseArgs`). */
  readonly args: readonly string[];
  /** Texto após o comando, sem o espaço inicial e com quebras de linha preservadas. */
  readonly rawArgs: string;
  /**
   * Aborta quando o `run` (ou o `onReject`) estoura o prazo (`timeoutMs` do comando ou
   * `timeouts.commandMs`), com
   * `reason` = `CommandTimeoutError`. Repasse a `fetch`/SDKs para parar o trabalho a tempo (ADR 0029);
   * depois do prazo, o `reply` deste contexto rejeita com `ContextExpiredError`. Montado pelo
   * `Bot`: quem usa o roteador solto o fornece no contexto passado a `dispatch`.
   */
  readonly signal: AbortSignal;
  /**
   * Faz a próxima mensagem do remetente, neste chat, ir para um passo de conversa do plugin
   * (ADR 0056). O `run` pergunta, registra a espera e termina, sem segurar o chat. Montado pelo
   * `Bot`, como o `signal`.
   */
  readonly expectReply: ExpectReply;
  /**
   * Texto de `messages` do plugin com os placeholders preenchidos: `{prefix}` com o prefixo
   * deste chat, os outros com `values` (ADR 0088). Montado pelo `Bot`, como o `signal`.
   */
  readonly t: MessageText<TKey>;
  /** Entrada de `accepts` que casou; `null` se o comando não declara `accepts`. */
  readonly accepted: AcceptedMessage | null;
  /**
   * Mídia da mensagem que casou com `accepts` (própria ou citada). Sem `accepts`, a da
   * própria mensagem ou, na falta dela, a da citada. `null` se nenhuma tiver mídia.
   */
  readonly media: Media | null;
}

/** Contexto do `run` cujo `accepts` só lista entradas com mídia: o roteador já garantiu as duas. */
export interface MediaCommandContext<TKey extends string = string> extends CommandContext<TKey> {
  readonly accepted: AcceptedMessage;
  readonly media: Media;
}

/**
 * Contexto do `run` para o `accepts` declarado: `MediaCommandContext` quando toda entrada tem
 * mídia. As tuplas evitam a distribuição sobre a união das entradas.
 */
export type CommandContextFor<A extends readonly AcceptSpec[], TKey extends string = string> = [
  A[number],
] extends [MediaAcceptSpec]
  ? MediaCommandContext<TKey>
  : CommandContext<TKey>;

/** Por que o roteador recusou rodar o comando. */
export type CommandRejection =
  | { readonly reason: 'role'; readonly required: CommandRole }
  | { readonly reason: 'accepts'; readonly accepts: readonly AcceptSpec[] };

/**
 * Contexto de `onReject`: ainda não há mídia resolvida nem `accepted`. No bot, o `onReject` tem
 * o mesmo prazo do `run`, e o `signal` aborta quando ele estoura.
 */
export type RejectContext<TKey extends string = string> = Omit<
  CommandContext<TKey>,
  'accepted' | 'media'
>;

/**
 * `A` é o `accepts` declarado: `command()` o infere para tipar o contexto do `run`
 * (`CommandContextFor`). O padrão, a lista larga, dá o `CommandContext`.
 */
export interface CommandDefinition<A extends readonly AcceptSpec[] = readonly AcceptSpec[]> {
  /** Nome sem o prefixo (`'sticker'`, não `'!sticker'`). Casado sem diferenciar caixa. */
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description?: string;
  /** Padrão: `'everyone'`. */
  readonly role?: CommandRole;
  /** A primeira entrada que casar, na ordem declarada, define `ctx.media`. */
  readonly accepts?: A;
  /**
   * Texto de resposta quando o comando é recusado (papel ou `accepts`). Sem `onReject`, ou
   * retornando `null`/`undefined`, a recusa é silenciosa.
   */
  readonly onReject?: (
    ctx: RejectContext,
    rejection: CommandRejection,
  ) => string | null | undefined | Promise<string | null | undefined>;
  /**
   * No bot, devolver texto (string ou `fmt`) responde citando a mensagem, como terminar com
   * `await ctx.reply(texto)` (ADR 0075). Outro valor é ignorado. O tipo segue `unknown` para
   * `run: (c) => c.reply('x')` continuar valendo.
   */
  readonly run: (ctx: CommandContextFor<A>) => unknown;
  /**
   * Prazo do `run` e do `onReject` no bot, em ms. Padrão: `timeouts.commandMs` do bot. Para o
   * comando que legitimamente demora (download, conversão): enquanto roda, ele segura o chat
   * (ADR 0038), então o prazo maior vale só para ele.
   */
  readonly timeoutMs?: number;
  /**
   * O `run` roda fora da fila do chat (ADR 0083): a próxima mensagem do chat não espera por ele.
   * Papel, `accepts` e `onReject` seguem na fila. O `run` mantém o contexto inteiro (`reply`,
   * `signal` com o `timeoutMs`, `log`), e a falha vai para `plugin.error` quando ele termina.
   * Duas execuções do mesmo chat podem terminar fora de ordem.
   */
  readonly background?: boolean;
  /**
   * Máximo de `run` simultâneos deste comando no bot, somando todos os chats (ADR 0084). A
   * execução excedente espera a vez em ordem de chegada, e a espera conta no prazo
   * (`timeoutMs`). A vaga volta quando o `run` termina de fato, mesmo depois do prazo. Inteiro
   * >= 1; padrão: sem limite.
   */
  readonly concurrency?: number;
  /**
   * Capabilities que o comando exige do transport (ADR 0086). No bot, sem alguma delas, o
   * comando não é registrado: fica fora do roteador, do `ctx.commands.list()` e do menu nativo,
   * como um plugin pulado pelo `requires` dele. O roteador solto ignora o campo.
   */
  readonly requires?: readonly Capability[];
  /**
   * Serviços que o comando exige (ADR 0095). No bot, se algum não estiver provido quando o
   * comando é registrado, ele fica de fora como no `requires`. Para o comando voltar quando o
   * provedor sobe, cai ou recarrega, o plugin declara o provedor em `optionalDependsOn` (ou
   * `dependsOn`): o reload em cascata registra os comandos de novo. O roteador solto ignora o
   * campo.
   */
  readonly services?: readonly ServiceName[];
}

/** Comando como os plugins o veem em `ctx.commands.list()` (ADR 0036): sem `run` nem `onReject`. */
export interface CommandInfo {
  /** Plugin que registrou o comando. */
  readonly plugin: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string | null;
  readonly role: CommandRole;
}

const TOKEN = /^\S+$/;

function assertToken(token: string, what: string): void {
  if (!TOKEN.test(token)) {
    throw new TypeError(
      `${what} de comando inválido: ${JSON.stringify(token)} (vazio ou com espaço)`,
    );
  }
}

/**
 * Lança `TypeError` se o nome ou algum alias for vazio ou tiver espaço (nunca casaria) e
 * `RangeError` se `timeoutMs` não for finito e > 0 (o `setTimeout` trataria `Infinity`/`NaN`
 * como 1 ms e o comando estouraria na hora) ou se `concurrency` não for inteiro >= 1 (0 nunca
 * rodaria). Entrada de `accepts` com mimetype mal formado, ou num tipo sem mídia, `'quoted:args'` e capability
 * desconhecida em `requires` também lançam `TypeError`, como serviço vazio ou não textual em
 * `services`.
 */
export function assertCommandDefinition(definition: CommandDefinition): void {
  assertToken(definition.name, 'Nome');
  for (const alias of definition.aliases ?? []) assertToken(alias, 'Alias');
  const { timeoutMs } = definition;
  if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new RangeError(`Prazo do comando "${definition.name}" inválido: ${timeoutMs}`);
  }
  const { concurrency } = definition;
  if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency >= 1)) {
    throw new RangeError(
      `Limite de concorrência do comando "${definition.name}" inválido: ${concurrency}`,
    );
  }
  for (const spec of definition.accepts ?? []) {
    const { quoted, type, mimetype } = parseAccept(spec);
    // O tipo já barra; a checagem é para quem define em JS. Os argumentos são só do comando.
    if (quoted && type === 'args') {
      throw new TypeError(
        `accepts do comando "${definition.name}" inválido: "quoted:args" (args é só da própria mensagem)`,
      );
    }
    if (mimetype === null) continue;
    if (!MEDIA_TYPES.has(type) || !MIMETYPE.test(mimetype)) {
      throw new TypeError(
        `accepts do comando "${definition.name}" inválido: ${JSON.stringify(spec)} (mimetype ` +
          'só em tipo com mídia, como "tipo/subtipo" ou "tipo/*")',
      );
    }
  }
  // O tipo já barra capability desconhecida; a checagem é para quem define em JS.
  for (const capability of definition.requires ?? []) {
    if (!isCapability(capability)) {
      throw new TypeError(
        `requires do comando "${definition.name}": capability desconhecida ${JSON.stringify(capability)}`,
      );
    }
  }
  // Como em `requires`: o tipo já barra, a checagem é para quem define em JS.
  for (const service of (definition.services ?? []) as readonly unknown[]) {
    if (typeof service !== 'string' || service.length === 0) {
      throw new TypeError(
        `services do comando "${definition.name}": nome de serviço inválido ${JSON.stringify(service)}`,
      );
    }
  }
}

/**
 * Define um comando. Valida nome, aliases, prazo e limite na definição, para o erro apontar o plugin que
 * declarou e não aparecer só quando alguém digitar o comando. Infere o `accepts` para tipar o
 * contexto do `run` (ver `CommandContextFor`).
 */
export function command<const A extends readonly AcceptSpec[] = readonly AcceptSpec[]>(
  definition: CommandDefinition<A>,
): CommandDefinition {
  assertCommandDefinition(definition);
  // O `run` estreitado recebe só o contexto que o roteador monta para este `accepts`.
  return definition as unknown as CommandDefinition;
}
