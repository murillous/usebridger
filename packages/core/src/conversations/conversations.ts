// Resposta esperada (ADR 0060): o handler pergunta, registra qual passo trata a próxima mensagem
// daquela pessoa naquele chat e termina, sem segurar o chat na fila de entrada (ADR 0042). O
// estado fica em memória; o passo definido com `persist: true` também grava a espera no storage
// do kernel, para ela sobreviver a um restart (ADR 0098). A leitura segue só em memória: o
// storage é a cópia que o boot restaura.

import type { BotMessageContext } from '#context.ts';
import { ExecutionTimeoutError } from '#deadline.ts';
import type { Logger } from '#logger/types.ts';
import type { Chat, Contact } from '#message/types.ts';
import type { Reply } from '#outbound/types.ts';
import type { MessageText } from '#plugin/messages.ts';
import type { Collection, JsonValue, WithId } from '#storage/types.ts';

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
  /**
   * Grava no storage do bot cada espera deste passo, e o boot seguinte a restaura (ADR 0098).
   * Custa uma escrita no `expectReply` e uma remoção quando a espera sai. Padrão: `false` (só em
   * memória; um restart a perde).
   */
  readonly persist?: boolean;
}

/** Passos de conversa do plugin (`ctx.conversations`). */
export interface Conversations {
  /**
   * Define o passo `step`, que trata a resposta registrada com `expectReply(step)`. Nome vazio ou
   * repetido no mesmo plugin lança `TypeError`, como um `onExpire` que não é função. O passo sai
   * no teardown/reload; as esperas dele saem junto, salvo as de passo com `persist: true`, que um
   * reload mantém (ADR 0098).
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

/** Versão do formato de `WaitRecord`. Mudou o formato, sobe a versão e o boot migra a antiga. */
export const WAIT_RECORD_VERSION = 1;

type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Espera persistida (ADR 0098), na coleção `waits` de `kernelStorage(sessão, 'conversations')`.
 * Um documento por (chat, remetente).
 */
export type WaitRecord = {
  /** Versão do formato (`WAIT_RECORD_VERSION`). */
  v: number;
  /** `chat.id` e `sender.id` soltos: é por eles que a remoção filtra. */
  chatId: string;
  senderId: string;
  /** O `Chat` da espera (com o `tenantId`, ADR 0072), para o `onExpire` rodar sem mensagem. */
  chat: JsonObject;
  /** O `Contact` de quem não respondeu, sem os `claims`: atributo verificado não vai ao disco. */
  sender: JsonObject;
  plugin: string;
  step: string;
  data: JsonValue;
  /**
   * Vencimento em epoch ms. Absoluto, e não o `ttlMs`: o tempo fora do ar conta, e a espera
   * vencida durante o restart expira no boot.
   */
  expiresAt: number;
};

export interface ConversationRegistryOptions {
  /**
   * Uma espera com `onExpire` venceu. O registro não a retira aqui: quem recebe põe a expiração
   * na fila do chat e chama `expire` quando a vez chegar, para a mensagem que entrou antes na
   * fila ainda responder (ADR 0097). Espera sem `onExpire` some direto, sem passar por aqui.
   */
  readonly onDue?: (chat: Chat, sender: Contact) => void;
  /**
   * Coleção das esperas persistidas, pedida só no primeiro uso (o `createBot` não faz I/O). Sem
   * ela, `define` com `persist` lança.
   */
  readonly store?: () => Collection<WaitRecord>;
  /** Logger do bot, lido a cada uso: ele nasce no `start()`. */
  readonly log?: () => Logger;
}

interface Wait {
  readonly plugin: string;
  readonly step: string;
  readonly data: JsonValue;
  readonly chat: Chat;
  readonly sender: Contact;
  /** Quando vence, em ms desde a época (`Date.now()`). */
  readonly dueAt: number;
  /** Há cópia no storage: a saída da espera a remove de lá. */
  readonly persist: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
  /** O timer já disparou: vale mesmo com o relógio de parede atrás do relógio do timer. */
  due: boolean;
  /**
   * Venceu, ou teve a expiração na vez dela, sem o passo definido: o plugin estava no meio de um
   * reload. O `sweep` seguinte retoma a expiração (ou descarta a espera, se o passo não voltou).
   */
  stalled: boolean;
}

interface StepEntry<C, O> {
  readonly run: KernelStep<C>;
  readonly expire: KernelExpire<O> | undefined;
  readonly persist: boolean;
}

/** Esperas e passos de todos os plugins de um bot (estado no closure do bot, ADR 0004). */
export class ConversationRegistry<C, O = unknown> {
  readonly #steps = new Map<string, Map<string, StepEntry<C, O>>>();
  readonly #waits = new Map<string, Wait>();
  readonly #onDue: ((chat: Chat, sender: Contact) => void) | undefined;
  // Escritas no storage por chave, em série: a remoção de uma espera nunca passa na frente da
  // gravação dela. Chaves diferentes não esperam umas pelas outras.
  readonly #writes = new Map<string, Promise<void>>();
  readonly #store: (() => Collection<WaitRecord>) | undefined;
  readonly #log: () => Logger | undefined;
  #collection: Collection<WaitRecord> | undefined;
  #closed = false;

  constructor(options: ConversationRegistryOptions = {}) {
    this.#onDue = options.onDue;
    this.#store = options.store;
    this.#log = options.log ?? (() => undefined);
  }

  define(
    plugin: string,
    step: string,
    run: KernelStep<C>,
    expire?: KernelExpire<O>,
    persist = false,
  ): void {
    if (typeof step !== 'string' || step.length === 0) {
      throw new TypeError(`plugin "${plugin}": nome de passo vazio`);
    }
    if (persist && this.#store === undefined) {
      throw new TypeError(`plugin "${plugin}": passo "${step}" com persist sem storage`);
    }
    let steps = this.#steps.get(plugin);
    if (steps === undefined) {
      steps = new Map();
      this.#steps.set(plugin, steps);
    }
    if (steps.has(step)) throw new TypeError(`plugin "${plugin}": passo "${step}" já definido`);
    steps.set(step, { run, expire, persist });
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
    const previous = this.#release(key);
    const wait = this.#arm(key, {
      plugin,
      step,
      data: options.data ?? null,
      chat,
      sender,
      dueAt: Date.now() + ttlMs,
      persist: entry.persist,
    });
    const replacesPersisted = previous?.persist === true;
    if (!(wait.persist || replacesPersisted)) return;
    // A cópia da anterior sai antes de a nova entrar. Sem espera persistida antes, a remoção
    // seria I/O à toa.
    this.#write(key, async (waits) => {
      if (replacesPersisted) await waits.delete({ chatId: chat.id, senderId: sender.id });
      if (wait.persist) await waits.insert(toRecord(wait));
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
    const run = this.#steps.get(wait.plugin)?.get(wait.step)?.run;
    // Só a espera persistida fica sem passo (o `removePlugin` tira as outras), e só entre o
    // `removePlugin` de um reload e o `sweep` dele (ADR 0098). Ninguém trataria a resposta, então
    // a mensagem segue o fluxo; a espera fica para o plugin recarregado ou para o `sweep` descartar.
    if (run === undefined) return undefined;
    this.#drop(key);
    return { plugin: wait.plugin, step: wait.step, data: wait.data, run };
  }

  /**
   * Ponto único de expiração (ADR 0097): retira a espera do remetente no chat **se ela venceu** e
   * devolve o que roda o `onExpire` do passo. Devolve `undefined` se não há espera, se a que há
   * ainda não venceu (a vencida foi respondida e trocada por outra no meio do caminho) ou se o
   * passo não tem `onExpire` (aí a vencida só some). O bot chama daqui de dentro da fila do chat;
   * uma espera restaurada do storage que venceu durante o restart passa pelo mesmo caminho
   * (ADR 0098).
   */
  expire(chatId: string, senderId: string): ExpiredReply<O> | undefined {
    const key = waitKey(chatId, senderId);
    const wait = this.#waits.get(key);
    if (wait === undefined || !(wait.due || Date.now() >= wait.dueAt)) return undefined;
    const entry = this.#steps.get(wait.plugin)?.get(wait.step);
    // Plugin no meio de um reload: o `sweep` dele retoma a expiração com o passo novo.
    if (entry === undefined) {
      wait.stalled = true;
      return undefined;
    }
    this.#drop(key);
    const { expire } = entry;
    if (expire === undefined) return undefined;
    const { plugin, step, data, chat, sender } = wait;
    return { plugin, step, data, chat, sender, run: expire };
  }

  /** O passo do plugin, para rodar sem espera (o clique num botão, ADR 0062). */
  find(plugin: string, step: string): KernelStep<C> | undefined {
    return this.#steps.get(plugin)?.get(step)?.run;
  }

  /**
   * Tira os passos do plugin e as esperas em memória dele (teardown/reload), com os timers. As de
   * passo persistido ficam: o reload as devolve ao plugin quando o `setup` novo redefine o passo,
   * e o `stop()` não pode apagá-las do storage. Quem desce de vez (disable, `setup` que falhou)
   * perde as dele no `sweep`.
   */
  removePlugin(plugin: string): void {
    this.#steps.delete(plugin);
    for (const [key, wait] of this.#waits) {
      if (wait.plugin === plugin && !wait.persist) this.#release(key);
    }
  }

  /**
   * Descarta, com `warn`, as esperas cujo passo não está definido (plugin desligado, `setup` que
   * falhou, passo renomeado), também do storage, e retoma a expiração da que venceu durante o
   * reload do plugin. O bot chama depois do boot e de cada mudança de plugin, quando todo plugin
   * que devia subir já rodou o `setup`.
   */
  sweep(): void {
    for (const [key, wait] of this.#waits) {
      if (!this.#steps.get(wait.plugin)?.has(wait.step)) {
        this.#drop(key);
        this.#warnOrphan(wait);
        continue;
      }
      if (!wait.stalled) continue;
      wait.stalled = false;
      this.#due(key, wait);
    }
  }

  /**
   * Restaura as esperas persistidas (ADR 0098). Roda no boot, depois do `setup` de todos os
   * plugins: a vencida durante o restart segue o caminho do timer que dispara (com `onExpire`, vai
   * à fila do chat pelo `onDue`; sem, some), a de passo que não existe mais é descartada com
   * `warn`, e as outras voltam com o tempo que faltava. Falha de leitura vai ao log e o boot segue
   * sem as conversas: perdê-las é melhor que não subir.
   */
  async restore(): Promise<void> {
    // Sem passo persistido, nada a restaurar: o bot que não usa o recurso não paga a leitura. Um
    // registro que sobrar fica para o boot que voltar a ter o passo.
    if (this.#store === undefined || this.#closed || !this.#hasPersistedStep()) return;
    let records: WithId<WaitRecord>[];
    try {
      records = await this.#waitsStore().find();
    } catch (error) {
      this.#log()?.error('conversas: falha ao ler as esperas persistidas; seguem fora da memória', {
        err: error,
      });
      return;
    }
    const now = Date.now();
    for (const record of latestPerKey(records, (stale) => this.#discard(stale))) {
      const key = waitKey(record.chatId, record.senderId);
      // Uma espera nova (registrada antes do restore) vale mais que a cópia antiga.
      if (this.#waits.has(key)) continue;
      const wait = this.#arm(key, {
        plugin: record.plugin,
        step: record.step,
        data: record.data,
        chat: record.chat as unknown as Chat,
        sender: record.sender as unknown as Contact,
        dueAt: record.expiresAt,
        persist: true,
      });
      // A órfã fica para o `sweep`, que avisa: a expiração é de quem ainda tem o passo.
      if (record.expiresAt <= now && this.#steps.get(record.plugin)?.has(record.step)) {
        this.#due(key, wait);
      }
    }
    this.sweep();
  }

  /** Espera as escritas pendentes no storage; o bot chama antes de fechá-lo. Nunca rejeita. */
  async flush(): Promise<void> {
    while (this.#writes.size > 0) await Promise.all(this.#writes.values());
  }

  /**
   * Descarta tudo da memória e recusa esperas novas: nenhum timer sobrevive ao shutdown. As
   * cópias persistidas ficam no storage para o próximo boot.
   */
  close(): void {
    this.#closed = true;
    for (const key of [...this.#waits.keys()]) this.#release(key);
    this.#steps.clear();
  }

  #hasPersistedStep(): boolean {
    for (const steps of this.#steps.values()) {
      for (const entry of steps.values()) if (entry.persist) return true;
    }
    return false;
  }

  /** Arma o timer de validade e guarda a espera; a nova e a restaurada passam por aqui. */
  #arm(key: string, fields: Omit<Wait, 'timer' | 'due' | 'stalled'>): Wait {
    // O restore entrega vencidas: sem o piso, o atraso seria negativo. Quem restaura chama o
    // `#due` na hora, e o `due` marcado impede o timer de repetir a expiração.
    const delay = Math.max(0, fields.dueAt - Date.now());
    const timer = setTimeout(() => {
      const current = this.#waits.get(key);
      if (current?.timer === timer && !current.due) this.#due(key, current);
    }, delay);
    // A espera não mantém o processo vivo: ela só importa se chegar mensagem.
    timer.unref?.();
    const wait: Wait = { ...fields, timer, due: false, stalled: false };
    this.#waits.set(key, wait);
    return wait;
  }

  /**
   * A espera venceu. Sem `onExpire`, a expiração continua silenciosa e não ocupa a fila do chat
   * (ADR 0060). Com ele, o bot põe a expiração na fila do chat e chama `expire` na vez dela.
   */
  #due(key: string, wait: Wait): void {
    wait.due = true;
    const entry = this.#steps.get(wait.plugin)?.get(wait.step);
    // Persistida que venceu durante o reload do plugin: o `sweep` dele decide, com o passo novo.
    if (entry === undefined) {
      wait.stalled = true;
      return;
    }
    if (entry.expire === undefined || this.#onDue === undefined) {
      this.#drop(key);
      return;
    }
    this.#onDue(wait.chat, wait.sender);
  }

  /** Tira a espera da memória (timer incluído), sem tocar no storage; devolve a que saiu. */
  #release(key: string): Wait | undefined {
    const wait = this.#waits.get(key);
    if (wait === undefined) return undefined;
    clearTimeout(wait.timer);
    this.#waits.delete(key);
    return wait;
  }

  /** Tira a espera da memória e, se persistida, do storage: ela saiu de vez. */
  #drop(key: string): void {
    const wait = this.#release(key);
    if (wait?.persist !== true) return;
    const { chat, sender } = wait;
    this.#write(key, (waits) => waits.delete({ chatId: chat.id, senderId: sender.id }));
  }

  /** Remove do storage um registro que não vira espera (duplicado ou malformado). */
  #discard(record: WithId<WaitRecord>): void {
    // Fila própria, pelo `id`: a chave (chat, remetente) é a do registro que fica.
    this.#write(`\u0001${record.id}`, (waits) => waits.delete(record.id));
  }

  #warnOrphan(wait: Wait): void {
    this.#log()?.warn(
      `conversas: espera descartada; o plugin "${wait.plugin}" não tem o passo "${wait.step}" ` +
        '(desligado, setup que falhou ou passo renomeado)',
      { plugin: wait.plugin, step: wait.step },
    );
  }

  /**
   * Põe a operação na fila da chave. A falha vai ao log: a espera em memória segue valendo, e o
   * pior caso é ela não voltar (ou voltar já respondida) depois de um restart.
   */
  #write(key: string, op: (waits: Collection<WaitRecord>) => Promise<unknown>): void {
    const previous = this.#writes.get(key) ?? Promise.resolve();
    const next: Promise<void> = previous
      .then(() => op(this.#waitsStore()))
      .then(
        () => undefined,
        (error: unknown) =>
          this.#log()?.warn('conversas: falha ao gravar espera no storage', { err: error }),
      )
      .finally(() => {
        if (this.#writes.get(key) === next) this.#writes.delete(key);
      });
    this.#writes.set(key, next);
  }

  #waitsStore(): Collection<WaitRecord> {
    // Só espera persistida chega aqui, e `define` recusa `persist` sem `store`.
    this.#collection ??= (this.#store as () => Collection<WaitRecord>)();
    return this.#collection;
  }
}

function toRecord(wait: Wait): WaitRecord {
  // Os claims são atributos verificados do token da sessão (ADR 0057): não sobrevivem a ela.
  const { claims: _claims, ...sender } = wait.sender;
  return {
    v: WAIT_RECORD_VERSION,
    chatId: wait.chat.id,
    senderId: wait.sender.id,
    chat: { ...wait.chat },
    sender,
    plugin: wait.plugin,
    step: wait.step,
    data: wait.data,
    expiresAt: wait.dueAt,
  };
}

/**
 * Registros válidos, um por (chat, remetente): o de vencimento mais tardio, que é o mais recente.
 * Duplicado só aparece se uma remoção falhou; ele e o malformado vão para `discard`. Versão
 * desconhecida (de um core mais novo, antes de um downgrade) fica no storage, intocada.
 */
function latestPerKey(
  records: readonly WithId<WaitRecord>[],
  discard: (record: WithId<WaitRecord>) => void,
): WithId<WaitRecord>[] {
  const latest = new Map<string, WithId<WaitRecord>>();
  for (const record of records) {
    if (record.v !== WAIT_RECORD_VERSION) continue;
    if (!isWaitRecord(record)) {
      discard(record);
      continue;
    }
    const key = waitKey(record.chatId, record.senderId);
    const kept = latest.get(key);
    if (kept !== undefined && kept.expiresAt >= record.expiresAt) {
      discard(record);
      continue;
    }
    if (kept !== undefined) discard(kept);
    latest.set(key, record);
  }
  return [...latest.values()];
}

/** O storage vem de fora do processo: o boot confere o formato antes de confiar no registro. */
function isWaitRecord(record: WaitRecord): boolean {
  const chat = record.chat as { readonly id?: unknown; readonly isGroup?: unknown } | null;
  const sender = record.sender as { readonly id?: unknown } | null;
  return (
    typeof record.chatId === 'string' &&
    typeof record.senderId === 'string' &&
    typeof chat === 'object' &&
    chat !== null &&
    chat.id === record.chatId &&
    typeof chat.isGroup === 'boolean' &&
    typeof sender === 'object' &&
    sender !== null &&
    sender.id === record.senderId &&
    typeof record.plugin === 'string' &&
    typeof record.step === 'string' &&
    'data' in record &&
    Number.isFinite(record.expiresAt)
  );
}

// NUL não aparece em ID de chat nem de contato de nenhuma plataforma: a chave não colide.
const waitKey = (chatId: string, senderId: string): string => `${chatId}\u0000${senderId}`;
