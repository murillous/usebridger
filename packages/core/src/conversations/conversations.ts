// Resposta esperada (ADR 0060): o handler pergunta, registra qual passo trata a próxima mensagem
// daquela pessoa naquele chat e termina, sem segurar o chat na fila de entrada (ADR 0042). O
// estado fica em memória; o passo é nomeado e o `data` é JSON para que uma espera possa ir ao
// storage depois sem mudar a API.

import type { BotMessageContext } from '#context.ts';
import { ExecutionTimeoutError } from '#deadline.ts';
import type { Logger } from '#logger/types.ts';
import type { Chat, Contact } from '#message/types.ts';
import type { Reply } from '#outbound/types.ts';
import type { MessageText } from '#plugin/messages.ts';
import type { JsonValue } from '#storage/types.ts';

/** Validade padrão de uma espera: 5 minutos. */
export const DEFAULT_REPLY_TTL_MS: number = 5 * 60_000;

/** Maior atraso que o `setTimeout` aceita; acima disso ele dispara na hora. */
const MAX_TTL_MS = 2_147_483_647;

export interface ExpectReplyOptions {
  /** Estado do fluxo, entregue ao passo em `ctx.data`. Padrão: `null`. */
  readonly data?: JsonValue;
  /**
   * Validade da espera em ms. Padrão: 5 minutos. Vencida, some; se o passo tem `onExpire`, ele
   * roda (ADR 0097).
   */
  readonly ttlMs?: number;
}

/**
 * Registra que a próxima mensagem do remetente, neste chat, vai para o passo `step` deste plugin.
 * Uma espera por (chat, remetente): registrar de novo, deste plugin ou de outro, troca a
 * anterior. Lança `TypeError` se o plugin não definiu o passo e `RangeError` com `ttlMs`
 * inválido.
 */
export type ExpectReply = (step: string, options?: ExpectReplyOptions) => void;

/** Contexto do passo: o da mensagem que respondeu, com o estado guardado na espera. */
export interface StepContext extends BotMessageContext {
  /** Nome do passo que está rodando. */
  readonly step: string;
  /** O `data` da espera; `null` se ela não trouxe nenhum. */
  readonly data: JsonValue;
  /**
   * Aborta quando o passo estoura o prazo (`timeouts.commandMs`), com `reason` =
   * `StepTimeoutError`, como o `signal` do comando.
   */
  readonly signal: AbortSignal;
  /** Encadeia a pergunta seguinte do fluxo (ver `ExpectReply`). */
  readonly expectReply: ExpectReply;
  /** Texto de `messages` do plugin com os placeholders preenchidos (ver `CommandContext.t`). */
  readonly t: MessageText;
}

export type StepHandler = (ctx: StepContext) => unknown;

/**
 * Contexto do `onExpire` (ADR 0097): a espera venceu sem resposta. Não há mensagem; o `reply`
 * envia no chat da espera, sem citar.
 */
export interface ExpireContext {
  /** Chat em que a espera foi registrada. */
  readonly chat: Chat;
  /** Quem não respondeu. */
  readonly sender: Contact;
  /** Nome do passo cuja espera venceu. */
  readonly step: string;
  /** O `data` da espera; `null` se ela não trouxe nenhum. */
  readonly data: JsonValue;
  /** Envia no chat da espera, sem citar (não há mensagem a citar). */
  readonly reply: Reply;
  readonly log: Logger;
  /**
   * Aborta quando o `onExpire` estoura o prazo (`timeouts.commandMs`), com `reason` =
   * `StepTimeoutError` (`stage: 'onExpire'`), ou no descarte do plugin.
   */
  readonly signal: AbortSignal;
  /** Abre outra espera para a mesma pessoa no mesmo chat ("Ainda está aí?"). */
  readonly expectReply: ExpectReply;
  /** Texto de `messages` do plugin com os placeholders preenchidos (ver `CommandContext.t`). */
  readonly t: MessageText;
}

export type ExpireHandler = (ctx: ExpireContext) => unknown;

export interface StepOptions {
  /**
   * Roda quando uma espera deste passo vence sem resposta (ADR 0097). Não roda quando a espera é
   * respondida, substituída, cancelada por um comando ou descartada (teardown, reload, `stop()`).
   */
  readonly onExpire?: ExpireHandler;
}

/** Passos de conversa do plugin (`ctx.conversations`). */
export interface Conversations {
  /**
   * Define o passo `step`, que trata a resposta registrada com `expectReply(step)`. Nome vazio ou
   * repetido no mesmo plugin lança `TypeError`, como um `onExpire` que não é função. O passo e as
   * esperas dele saem no teardown/reload.
   */
  define(step: string, handler: StepHandler, options?: StepOptions): void;
}

/** Parte do passo que estourou o prazo: o tratamento da resposta ou o `onExpire`. */
export type StepStage = 'run' | 'onExpire';

/**
 * O passo (ou o `onExpire` dele) estourou o prazo. Vai em `plugin.error` com `timedOut: true` e
 * `phase: 'step'` ou `'step-expire'`.
 */
export class StepTimeoutError extends ExecutionTimeoutError {
  override readonly name: string = 'StepTimeoutError';
  readonly step: string;
  readonly stage: StepStage;

  constructor(plugin: string, step: string, timeoutMs: number, stage: StepStage = 'run') {
    super(plugin, stage === 'run' ? `passo "${step}"` : `onExpire do passo "${step}"`, timeoutMs);
    this.step = step;
    this.stage = stage;
  }
}

/** Passo como o kernel o roda: já com prazo e visão do plugin, montados por quem o define. */
export type KernelStep<C> = (ctx: C, data: JsonValue) => unknown;

/**
 * `onExpire` como o kernel o roda: com prazo e visão do plugin. `O` é a origem (chat e
 * remetente) que o bot monta para o `reply` sair pela fila de saída.
 */
export type KernelExpire<O> = (origin: O, data: JsonValue) => unknown;

/** Espera consumida por `take`: o que o bot precisa para rodar o passo. */
export interface PendingReply<C> {
  readonly plugin: string;
  readonly step: string;
  readonly data: JsonValue;
  readonly run: KernelStep<C>;
}

/** Espera vencida, retirada por `expire`: o que o bot precisa para rodar o `onExpire`. */
export interface ExpiredReply<O> {
  readonly plugin: string;
  readonly step: string;
  readonly data: JsonValue;
  readonly chat: Chat;
  readonly sender: Contact;
  readonly run: KernelExpire<O>;
}

export interface ConversationRegistryOptions {
  /**
   * Uma espera com `onExpire` venceu. O registro não a retira aqui: quem recebe põe a expiração
   * na fila do chat e chama `expire` quando a vez chegar, para a mensagem que entrou antes na
   * fila ainda responder (ADR 0097). Espera sem `onExpire` some direto, sem passar por aqui.
   */
  readonly onDue?: (chat: Chat, sender: Contact) => void;
}

interface Wait {
  readonly plugin: string;
  readonly step: string;
  readonly data: JsonValue;
  readonly chat: Chat;
  readonly sender: Contact;
  /** Quando vence, em ms desde a época (`Date.now()`). */
  readonly dueAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
  /** O timer já disparou: vale mesmo com o relógio de parede atrás do relógio do timer. */
  due: boolean;
}

interface StepEntry<C, O> {
  readonly run: KernelStep<C>;
  readonly expire: KernelExpire<O> | undefined;
}

/** Esperas e passos de todos os plugins de um bot (estado no closure do bot, ADR 0004). */
export class ConversationRegistry<C, O = unknown> {
  readonly #steps = new Map<string, Map<string, StepEntry<C, O>>>();
  readonly #waits = new Map<string, Wait>();
  readonly #onDue: ((chat: Chat, sender: Contact) => void) | undefined;
  #closed = false;

  constructor(options: ConversationRegistryOptions = {}) {
    this.#onDue = options.onDue;
  }

  define(plugin: string, step: string, run: KernelStep<C>, expire?: KernelExpire<O>): void {
    if (typeof step !== 'string' || step.length === 0) {
      throw new TypeError(`plugin "${plugin}": nome de passo vazio`);
    }
    let steps = this.#steps.get(plugin);
    if (steps === undefined) {
      steps = new Map();
      this.#steps.set(plugin, steps);
    }
    if (steps.has(step)) throw new TypeError(`plugin "${plugin}": passo "${step}" já definido`);
    steps.set(step, { run, expire });
  }

  expect(
    plugin: string,
    chat: Chat,
    sender: Contact,
    step: string,
    options: ExpectReplyOptions = {},
  ): void {
    const entry = this.#steps.get(plugin)?.get(step);
    if (entry === undefined) {
      throw new TypeError(
        `plugin "${plugin}": expectReply("${step}") sem o passo; defina-o com ` +
          'ctx.conversations.define',
      );
    }
    const ttlMs = options.ttlMs ?? DEFAULT_REPLY_TTL_MS;
    if (!(Number.isFinite(ttlMs) && ttlMs > 0 && ttlMs <= MAX_TTL_MS)) {
      throw new RangeError(`plugin "${plugin}": ttlMs de expectReply inválido: ${ttlMs}`);
    }
    // Depois do shutdown não há quem responda, e o timer sobreviveria ao `stop()`.
    if (this.#closed) return;
    const key = waitKey(chat.id, sender.id);
    this.#drop(key);
    const timer = setTimeout(() => {
      const current = this.#waits.get(key);
      if (current?.timer !== timer) return;
      // Sem `onExpire`, a expiração continua silenciosa e não ocupa a fila do chat (ADR 0060).
      if (entry.expire === undefined || this.#onDue === undefined) {
        this.#waits.delete(key);
        return;
      }
      current.due = true;
      this.#onDue(current.chat, current.sender);
    }, ttlMs);
    // A espera não mantém o processo vivo: ela só importa se chegar mensagem.
    timer.unref?.();
    this.#waits.set(key, {
      plugin,
      step,
      data: options.data ?? null,
      chat,
      sender,
      dueAt: Date.now() + ttlMs,
      timer,
      due: false,
    });
  }

  /**
   * Retira a espera do remetente no chat, se houver. Quem chama decide se roda o passo ou, com um
   * comando digitado, só a descarta. O mapa vazio sai sem montar a chave: o caminho de cada
   * mensagem não paga nada sem conversa aberta. Uma espera já vencida, cuja expiração ainda está
   * na fila atrás desta mensagem, também responde: quem chegou antes à fila ganha (ADR 0097).
   */
  take(chatId: string, senderId: string): PendingReply<C> | undefined {
    if (this.#waits.size === 0) return undefined;
    const key = waitKey(chatId, senderId);
    const wait = this.#waits.get(key);
    if (wait === undefined) return undefined;
    this.#drop(key);
    // O passo existe: o `removePlugin` tira passos e esperas juntos.
    const entry = this.#steps.get(wait.plugin)?.get(wait.step) as StepEntry<C, O>;
    return { plugin: wait.plugin, step: wait.step, data: wait.data, run: entry.run };
  }

  /**
   * Ponto único de expiração (ADR 0097): retira a espera do remetente no chat **se ela venceu** e
   * devolve o que roda o `onExpire` do passo. Devolve `undefined` se não há espera, se a que há
   * ainda não venceu (a vencida foi respondida e trocada por outra no meio do caminho) ou se o
   * passo não tem `onExpire` (aí a vencida só some). O bot chama daqui de dentro da fila do chat;
   * uma espera restaurada do storage que venceu durante o restart passa pelo mesmo caminho.
   */
  expire(chatId: string, senderId: string): ExpiredReply<O> | undefined {
    const key = waitKey(chatId, senderId);
    const wait = this.#waits.get(key);
    if (wait === undefined || !(wait.due || Date.now() >= wait.dueAt)) return undefined;
    this.#drop(key);
    const expire = this.#steps.get(wait.plugin)?.get(wait.step)?.expire;
    if (expire === undefined) return undefined;
    const { plugin, step, data, chat, sender } = wait;
    return { plugin, step, data, chat, sender, run: expire };
  }

  /** O passo do plugin, para rodar sem espera (o clique num botão, ADR 0062). */
  find(plugin: string, step: string): KernelStep<C> | undefined {
    return this.#steps.get(plugin)?.get(step)?.run;
  }

  /** Tira os passos e as esperas do plugin (teardown/reload), com os timers. */
  removePlugin(plugin: string): void {
    this.#steps.delete(plugin);
    for (const [key, wait] of this.#waits) {
      if (wait.plugin === plugin) this.#drop(key);
    }
  }

  /** Descarta tudo e recusa esperas novas: nenhum timer sobrevive ao shutdown. */
  close(): void {
    this.#closed = true;
    for (const key of [...this.#waits.keys()]) this.#drop(key);
    this.#steps.clear();
  }

  #drop(key: string): void {
    const wait = this.#waits.get(key);
    if (wait === undefined) return;
    clearTimeout(wait.timer);
    this.#waits.delete(key);
  }
}

// NUL não aparece em ID de chat nem de contato de nenhuma plataforma: a chave não colide.
const waitKey = (chatId: string, senderId: string): string => `${chatId}\u0000${senderId}`;
