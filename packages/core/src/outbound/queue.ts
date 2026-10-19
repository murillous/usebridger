// Fila de saída anti-ban (ADR 0017). Todo envio do bot passa por aqui: intervalo mínimo global
// e por chat, prioridade (comando > broadcast), retry com backoff (ou na janela que a plataforma
// informou, ADR 0063) e humanização opcional.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Observers, OutboundSentSignal } from '#observers/observers.ts';
import type { MessageText } from '#text/format.ts';
import { assertCanSend } from '#transport/capabilities.ts';
import type {
  MessageKey,
  OutgoingContent,
  SendOptions,
  Transport,
  TypingKind,
} from '#transport/types.ts';
import { AlbumSplitter } from './album.ts';
import { OutboundQueueError } from './errors.ts';
import { Fifo } from './fifo.ts';
import { type OutboundConfig, resolveOutboundOptions } from './options.ts';
import { retryAfter, retryDelay } from './retry.ts';
import { type SendPart, TextLimiter, toContent } from './text.ts';
import type { ActionOptions, OutboundSendOptions, Sender, SendPriority } from './types.ts';

/** O que a fila usa do transport. */
export type OutboundTransport = Pick<
  Transport,
  'name' | 'capabilities' | 'send' | 'sendTyping' | 'limits' | 'pacing'
>;

export interface RetryOptions {
  /** Tentativas no total, contando a primeira. Padrão: 3. `1` desliga o retry. */
  readonly maxAttempts?: number;
  /** Espera antes da primeira re-tentativa, em ms; dobra a cada falha. Padrão: 1000. */
  readonly baseDelayMs?: number;
  /**
   * Teto da espera, em ms. Padrão: 30000. Um erro com `retryAfterMs` acima dele não re-tenta: a
   * resposta já sairia fora de contexto (ADR 0063).
   */
  readonly maxDelayMs?: number;
  /**
   * Decide se a falha é transitória. Padrão: tudo, exceto `UnsupportedError` e erros com
   * `retryable: false` (convenção para o transport marcar falha permanente).
   */
  readonly isRetryable?: (error: unknown) => boolean;
}

export interface HumanizeOptions {
  /** Tempo "digitando" por caractere do texto, em ms. Padrão: 50. */
  readonly msPerChar?: number;
  /** Piso do tempo de "digitando", em ms. Padrão: 500. */
  readonly minMs?: number;
  /** Teto do tempo de "digitando", em ms; voz usa o teto. Padrão: 3000. */
  readonly maxMs?: number;
}

export interface OutboundQueueOptions {
  readonly transport: OutboundTransport;
  /**
   * Intervalo mínimo entre dois envios quaisquer, em ms. Padrão: o `transport.pacing`, ou 300.
   */
  readonly globalIntervalMs?: number;
  /**
   * Intervalo mínimo entre dois envios ao mesmo chat, em ms. Padrão: o `transport.pacing`, ou
   * 1000.
   */
  readonly chatIntervalMs?: number;
  /**
   * Máximo de mensagens aguardando em cada prioridade, somando os chats. Padrão: 1000.
   * `Infinity` desliga. Por prioridade para um broadcast que encheu a fila não recusar respostas.
   */
  readonly maxPending?: number;
  readonly retry?: RetryOptions;
  /**
   * "Digitando" (`text`) antes de texto e "gravando" (`voice`) antes de voz, se o transport tiver a
   * capability `typing`. Padrão: desligada.
   */
  readonly humanize?: boolean | HumanizeOptions;
  /**
   * Destino das falhas do "digitando", que não impedem o envio. Sem ele, a falha é descartada:
   * o indicador é cosmético e quem chamou `send` só se importa com a mensagem.
   */
  readonly onTypingError?: (error: unknown, chatId: string) => void;
  /**
   * Quanto o que aguarda pode esperar com a fila pausada (conexão caída), em ms. Estourado, rejeita
   * com `OutboundQueueError` `'disconnected'`, e envios novos rejeitam na hora até o `resume()`.
   * Padrão: 60000 (cobre o ciclo de reconexão padrão, 5 + 10 + 15 s). `Infinity` desliga.
   */
  readonly maxPauseMs?: number;
  /**
   * Prazo de cada chamada ao transport ("digitando" e envio), em ms. Estourado, o envio rejeita com
   * `OutboundQueueError` `'timeout'`, sem re-tentar, e libera o chat. Padrão: 30000. `Infinity`
   * desliga.
   */
  readonly sendTimeoutMs?: number;
  /** Relógio em ms. Padrão: `performance.now` (monotônico). */
  readonly clock?: () => number;
  /** Fonte do jitter do backoff, em [0, 1). Padrão: `Math.random`. */
  readonly random?: () => number;
  /** Destino do sinal `outbound.sent` de cada `send` (ADR 0102). */
  readonly observers?: Pick<Observers, 'has' | 'emit'>;
}

/**
 * Origem da resposta do `ctx.reply`, para o sinal `outbound.sent` (ADR 0102). Chave `Symbol` fora
 * do `index.ts`: um plugin não a forja pelo `ctx.send`, e a fila a retira antes do transport.
 */
export const REPLY_ORIGIN: unique symbol = Symbol('replyOrigin');

export interface ReplyOriginInfo {
  readonly chatType: 'group' | 'private';
  /** Ausente na resposta sem mensagem a citar (`onExpire`). */
  readonly messageId?: string;
}

/** As opções do `send` com a origem que só o kernel preenche. */
export type QueueSendOptions = OutboundSendOptions & { readonly [REPLY_ORIGIN]?: ReplyOriginInfo };

export interface OutboundQueueStats {
  /** Mensagens aguardando, inclusive as em espera de re-tentativa. */
  readonly pending: { readonly high: number; readonly normal: number; readonly low: number };
  /** Envios em andamento ("digitando" + transport). */
  readonly inFlight: number;
  /** Chats com mensagem aguardando ou em andamento. */
  readonly activeChats: number;
  readonly sent: number;
  /** Envios que rejeitaram com o erro final. */
  readonly failed: number;
  readonly retries: number;
  /** Recusadas (fila cheia, fechada ou desconectada) ou descartadas sem envio. */
  readonly dropped: number;
  /** Despacho pausado pela conexão caída. */
  readonly paused: boolean;
}

export interface OutboundCloseOptions {
  /**
   * `true` (padrão): envia tudo o que já foi aceito antes de resolver. `false`: rejeita o que
   * aguarda e só espera os envios em andamento.
   */
  readonly drain?: boolean;
}

export { OutboundQueueError, type OutboundQueueErrorReason } from './errors.ts';

/** Índice nas estruturas por prioridade: 0 é a mais alta. */
type PriorityIndex = 0 | 1 | 2;

// Map e não objeto: prioridade vinda de JS sem tipos (ex.: `'toString'`) não casa por engano.
const PRIORITY_INDEX: ReadonlyMap<string, PriorityIndex> = new Map<SendPriority, PriorityIndex>([
  ['high', 0],
  ['normal', 1],
  ['low', 2],
]);

/** Uma chamada ao transport e o conteúdo dela, para a humanização (`null` nas ações). */
interface JobPart {
  readonly run: () => Promise<unknown>;
  readonly content: OutgoingContent | null;
}

interface Job extends JobPart {
  /**
   * Partes seguintes de um texto dividido (ADR 0057). Cada uma sai logo depois da anterior, na
   * frente do chat, para outro envio não se intrometer.
   */
  readonly rest: readonly JobPart[];
  /** Resultado da primeira parte, com que a última resolve; ausente até ela sair. */
  readonly first?: { readonly value: unknown };
  /** O que é a chamada, para a mensagem do prazo estourado. */
  readonly what: string;
  readonly priority: PriorityIndex;
  /** Tentativas já feitas. */
  attempts: number;
  /** Medida do `send` para o `outbound.sent`; ausente sem observador. As partes a dividem. */
  readonly track: Track | undefined;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  /**
   * Contexto assíncrono de quem enfileirou. O job roda nele, e não no de quem disparou o pump: um
   * `send` feito num observador de `log` (ADR 0105) despacha jobs de outros chats e não pode
   * emprestar o silêncio a eles (#163).
   */
  readonly context: ReturnType<typeof AsyncLocalStorage.snapshot>;
}

interface Track {
  readonly startedAt: number;
  /** Último despacho ao transport; `NaN` enquanto não saiu da espera. */
  dispatchedAt: number;
  retries: number;
}

interface ChatState {
  readonly id: string;
  readonly jobs: readonly [Fifo<Job>, Fifo<Job>, Fifo<Job>];
  /**
   * Mensagem em espera de re-tentativa ou parte seguinte de um texto dividido: sai antes das
   * outras do chat, para não embaralhar.
   */
  head: Job | null;
  pending: number;
  busy: boolean;
  /** Antes disso o chat não envia (intervalo por chat ou backoff). */
  readyAt: number;
  /** Senha da entrada válida numa lista de prontos; 0 = fora das listas. */
  ticket: number;
  listedPriority: PriorityIndex | -1;
  timer: NodeJS.Timeout | undefined;
}

interface ReadyEntry {
  readonly chat: ChatState;
  readonly ticket: number;
}

/**
 * Fila de saída de uma instância do bot. Chats diferentes enviam em paralelo, limitados só
 * pelo intervalo global; dentro do chat, uma mensagem por vez, em ordem por prioridade.
 */
export class OutboundQueue implements Sender {
  readonly #transport: OutboundTransport;
  readonly #text: TextLimiter;
  readonly #album: AlbumSplitter;
  readonly #config: OutboundConfig;
  readonly #observers: Pick<Observers, 'has' | 'emit'> | undefined;

  // Só chats com mensagem aguardando ou em andamento: ao esvaziar, saem (o vazamento do
  // rateLimiter do legacy).
  readonly #chats = new Map<string, ChatState>();
  // Fim do intervalo por chat, em ordem de envio. Como o intervalo é fixo, a ordem de inserção
  // é a de vencimento e a limpeza para na primeira entrada válida.
  readonly #cooldowns = new Map<string, number>();
  // Chats prontos para enviar, um FIFO por prioridade. Remoção preguiçosa: entradas cujo
  // ticket não bate mais são descartadas ao chegar na frente.
  readonly #ready: readonly [Fifo<ReadyEntry>, Fifo<ReadyEntry>, Fifo<ReadyEntry>] = [
    new Fifo(),
    new Fifo(),
    new Fifo(),
  ];
  readonly #pendingBy: Record<PriorityIndex, number> = [0, 0, 0];
  #nextTicket = 1;
  #globalReadyAt = Number.NEGATIVE_INFINITY;
  #globalTimer: NodeJS.Timeout | undefined;
  #pumping = false;
  #idleWaiters: (() => void)[] = [];
  #closed = false;
  #discarding = false;
  #paused = false;
  // Pausada além do teto: o que chega rejeita na hora, em vez de acumular sem previsão de saída.
  #offline = false;
  #pauseTimer: NodeJS.Timeout | undefined;
  // Esperas de humanização em curso: o descarte as encerra para o envio não sair depois do close.
  readonly #sleepers = new Set<() => void>();
  #inFlight = 0;
  #sent = 0;
  #failed = 0;
  #retries = 0;
  #dropped = 0;

  constructor(options: OutboundQueueOptions) {
    this.#config = resolveOutboundOptions(options);
    this.#transport = options.transport;
    this.#text = new TextLimiter(options.transport);
    this.#album = new AlbumSplitter(options.transport);
    this.#observers = options.observers;
  }

  /**
   * Enfileira o envio. Resolve com a chave da mensagem criada ou rejeita com o erro final
   * (capability ausente, fila cheia/fechada ou falha do transport após as re-tentativas). Um
   * texto acima do limite do transport sai em partes, e a chave é a da primeira (ADR 0057).
   */
  send(
    chatId: string,
    input: OutgoingContent | MessageText,
    options?: QueueSendOptions,
  ): Promise<MessageKey> {
    let sendOptions: SendOptions | undefined;
    let origin: ReplyOriginInfo | undefined;
    if (options !== undefined) {
      // A origem sai por nome, e não só por ser não enumerável: o `...rest` copia chave `Symbol`.
      const { priority: _priority, [REPLY_ORIGIN]: replyOrigin, ...rest } = options;
      sendOptions = rest;
      origin = replyOrigin;
    }
    let content: OutgoingContent;
    let parts: SendPart[];
    try {
      content = toContent(input);
      parts =
        content.type === 'album'
          ? this.#album
              .split(content, sendOptions)
              .flatMap((part) => this.#text.split(part.content, part.options))
          : this.#text.split(content, sendOptions);
    } catch (error) {
      return Promise.reject(error);
    }
    const [head, ...rest] = parts.map(
      ({ content, options: partOptions }): JobPart => ({
        run: () => this.#transport.send(chatId, content, partOptions),
        content,
      }),
    );
    const track: Track | undefined = this.#observers?.has('outbound.sent')
      ? { startedAt: this.#config.clock(), dispatchedAt: Number.NaN, retries: 0 }
      : undefined;
    const sending = this.#push(chatId, options?.priority, {
      ...(head as JobPart),
      rest,
      what: `envio para ${chatId}`,
      track,
      // Capability ausente nunca vira tentativa: falha já, sem ocupar a fila. Uma legenda
      // dividida também exige `send.text`.
      check: () => {
        for (const part of parts) assertCanSend(this.#transport, part.content, part.options);
      },
    }) as Promise<MessageKey>;
    if (track === undefined) return sending;
    const emit = (status: OutboundSentSignal['status']): void => {
      const end = Number.isNaN(track.dispatchedAt) ? this.#config.clock() : track.dispatchedAt;
      this.#observers?.emit('outbound.sent', {
        chatId,
        ...(origin !== undefined && { chatType: origin.chatType }),
        kind: content.type,
        status,
        queuedMs: end - track.startedAt,
        retries: track.retries,
        ...(origin?.messageId !== undefined && { replyTo: origin.messageId }),
      });
    };
    return sending.then(
      (key) => {
        emit('sent');
        return key;
      },
      (error: unknown) => {
        // Recusa da própria fila (cheia, fechada, desconectada) não chegou a falhar no transport.
        const dropped = error instanceof OutboundQueueError && error.reason !== 'timeout';
        emit(dropped ? 'dropped' : 'failed');
        throw error;
      },
    );
  }

  /**
   * Enfileira uma ação que gera tráfego sem ser envio (reação, edição, "digitando", participantes de
   * grupo; ADR 0036), com as mesmas regras do envio: intervalos, prioridade, retry, pausa e prazo.
   * Sem humanização. Quem chama confere a capability antes: a fila não conhece a ação.
   */
  enqueue<T>(chatId: string, action: () => Promise<T>, options?: ActionOptions): Promise<T> {
    return this.#push(chatId, options?.priority, {
      run: action,
      content: null,
      rest: [],
      what: `ação em ${chatId}`,
      track: undefined,
    }) as Promise<T>;
  }

  #push(
    chatId: string,
    requested: SendPriority | undefined,
    spec: Pick<Job, 'run' | 'content' | 'rest' | 'what' | 'track'> & {
      readonly check?: () => void;
    },
  ): Promise<unknown> {
    if (this.#closed) {
      this.#dropped++;
      return Promise.reject(
        new OutboundQueueError('closed', `fila de saída fechada: ${spec.what} recusado`),
      );
    }
    if (this.#offline) {
      this.#dropped++;
      return Promise.reject(
        new OutboundQueueError(
          'disconnected',
          `conexão caída há mais de ${this.#config.maxPauseMs} ms: ${spec.what} recusado`,
        ),
      );
    }
    const priority = PRIORITY_INDEX.get(requested ?? 'normal');
    if (priority === undefined) {
      return Promise.reject(new TypeError(`prioridade inválida: ${String(requested)}`));
    }
    try {
      spec.check?.();
    } catch (error) {
      return Promise.reject(error);
    }
    // Limite por prioridade: `low`/`normal` acumulados nunca tiram a vaga de uma `high`.
    if (this.#pendingBy[priority] >= this.#config.maxPending) {
      this.#dropped++;
      return Promise.reject(
        new OutboundQueueError(
          'full',
          `fila de saída cheia (${this.#config.maxPending} aguardando com prioridade ${requested ?? 'normal'}): ${spec.what} recusado`,
        ),
      );
    }

    return new Promise<unknown>((resolve, reject) => {
      const job: Job = {
        run: spec.run,
        content: spec.content,
        rest: spec.rest,
        what: spec.what,
        priority,
        attempts: 0,
        track: spec.track,
        resolve,
        reject,
        context: AsyncLocalStorage.snapshot(),
      };
      const chat = this.#chatFor(chatId);
      chat.jobs[priority].push(job);
      chat.pending++;
      this.#pendingBy[priority]++;
      this.#wake(chat, this.#config.clock());
      this.#pump();
    });
  }

  stats(): OutboundQueueStats {
    return {
      pending: {
        high: this.#pendingBy[0],
        normal: this.#pendingBy[1],
        low: this.#pendingBy[2],
      },
      inFlight: this.#inFlight,
      activeChats: this.#chats.size,
      sent: this.#sent,
      failed: this.#failed,
      retries: this.#retries,
      dropped: this.#dropped,
      paused: this.#paused,
    };
  }

  get closed(): boolean {
    return this.#closed;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /**
   * Para de despachar (a conexão caiu): o que aguarda e o que chegar esperam o `resume()`, até
   * `maxPauseMs`. Envios em andamento terminam; se falharem, a re-tentativa também espera.
   */
  pause(): void {
    if (this.#paused) return;
    this.#paused = true;
    if (this.#config.maxPauseMs === Number.POSITIVE_INFINITY) return;
    this.#pauseTimer = setTimeout(() => {
      this.#pauseTimer = undefined;
      this.#offline = true;
      this.#rejectWaiting(
        () =>
          new OutboundQueueError(
            'disconnected',
            `conexão caída há mais de ${this.#config.maxPauseMs} ms: envio descartado`,
          ),
      );
    }, this.#config.maxPauseMs);
  }

  /** Volta a despachar (a conexão abriu), inclusive depois de estourado o `maxPauseMs`. */
  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    this.#offline = false;
    clearTimeout(this.#pauseTimer);
    this.#pauseTimer = undefined;
    this.#pump();
  }

  /** Resolve quando não há mensagem aguardando nem em andamento. Não impede novos envios. */
  onIdle(): Promise<void> {
    if (this.#chats.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /**
   * Para de aceitar envios (novos rejeitam com `OutboundQueueError` `'closed'`) e resolve quando
   * a fila esvaziar. Pode ser chamado de novo com `drain: false` para abortar uma drenagem.
   */
  close(options: OutboundCloseOptions = {}): Promise<void> {
    this.#closed = true;
    if (options.drain === false) this.#discard();
    return this.onIdle();
  }

  #chatFor(chatId: string): ChatState {
    const existing = this.#chats.get(chatId);
    if (existing !== undefined) return existing;
    const chat: ChatState = {
      id: chatId,
      jobs: [new Fifo(), new Fifo(), new Fifo()],
      head: null,
      pending: 0,
      busy: false,
      readyAt: this.#cooldowns.get(chatId) ?? Number.NEGATIVE_INFINITY,
      ticket: 0,
      listedPriority: -1,
      timer: undefined,
    };
    this.#chats.set(chatId, chat);
    return chat;
  }

  /** Coloca o chat na lista de prontos ou agenda quando ele ficará pronto. */
  #wake(chat: ChatState, now: number): void {
    if (chat.busy || chat.pending === 0) return;
    if (now < chat.readyAt) {
      chat.timer ??= setTimeout(() => {
        chat.timer = undefined;
        this.#wake(chat, this.#config.clock());
        this.#pump();
      }, chat.readyAt - now);
      return;
    }
    const priority = chat.head !== null ? chat.head.priority : firstNonEmpty(chat.jobs);
    if (priority === -1 || (chat.ticket !== 0 && chat.listedPriority === priority)) return;
    // Nova senha invalida a entrada antiga (ex.: chegou mensagem de prioridade maior).
    chat.ticket = this.#nextTicket++;
    chat.listedPriority = priority;
    this.#ready[priority].push({ chat, ticket: chat.ticket });
  }

  #pump(): void {
    if (this.#pumping || this.#paused) return;
    this.#pumping = true;
    try {
      for (;;) {
        const list = this.#peekReady();
        if (list === undefined) return;
        const now = this.#config.clock();
        if (now < this.#globalReadyAt) {
          this.#globalTimer ??= setTimeout(() => {
            this.#globalTimer = undefined;
            this.#pump();
          }, this.#globalReadyAt - now);
          return;
        }
        const entry = list.shift();
        if (entry !== undefined) this.#dispatch(entry.chat, now);
      }
    } finally {
      this.#pumping = false;
    }
  }

  /** Lista de maior prioridade com entrada válida na frente; descarta as obsoletas. */
  #peekReady(): Fifo<ReadyEntry> | undefined {
    for (const list of this.#ready) {
      for (let entry = list.peek(); entry !== undefined; entry = list.peek()) {
        if (entry.ticket === entry.chat.ticket) return list;
        list.shift();
      }
    }
    return undefined;
  }

  #dispatch(chat: ChatState, now: number): void {
    let job = chat.head;
    if (job !== null) {
      chat.head = null;
    } else {
      const priority = firstNonEmpty(chat.jobs);
      job = priority === -1 ? null : (chat.jobs[priority].shift() ?? null);
      // Inalcançável: só chat com mensagem entra na lista de prontos.
      if (job === null) return;
    }
    chat.ticket = 0;
    chat.busy = true;
    chat.pending--;
    this.#pendingBy[job.priority]--;
    this.#inFlight++;
    if (job.track !== undefined) job.track.dispatchedAt = now;
    this.#globalReadyAt = now + this.#config.globalIntervalMs;
    chat.readyAt = now + this.#config.chatIntervalMs;
    this.#rememberCooldown(chat.id, chat.readyAt, now);
    void job.context(() => this.#execute(chat, job));
  }

  #rememberCooldown(chatId: string, readyAt: number, now: number): void {
    for (const [id, until] of this.#cooldowns) {
      if (until > now) break;
      this.#cooldowns.delete(id);
    }
    this.#cooldowns.delete(chatId);
    this.#cooldowns.set(chatId, readyAt);
  }

  async #execute(chat: ChatState, job: Job): Promise<void> {
    job.attempts++;
    try {
      if (this.#config.humanize !== null && job.content !== null) {
        await this.#simulate(chat.id, job.content, this.#config.humanize);
      }
      // Descartada durante o "digitando": o envio não chegou ao transport e não sai.
      if (this.#discarding) {
        this.#drop(job);
      } else {
        const result = await this.#withTimeout(job.run(), job.what);
        this.#sent++;
        this.#settle(chat, job, result);
      }
    } catch (error) {
      this.#handleFailure(chat, job, error);
    }
    this.#inFlight--;
    chat.busy = false;
    if (chat.pending === 0) {
      clearTimeout(chat.timer);
      this.#chats.delete(chat.id);
      this.#notifyIdle();
    } else {
      this.#wake(chat, this.#config.clock());
    }
    this.#pump();
  }

  /** Resolve o envio ou, num texto dividido, põe a parte seguinte na frente do chat. */
  #settle(chat: ChatState, job: Job, result: unknown): void {
    const first = job.first ?? { value: result };
    const [next, ...rest] = job.rest;
    if (next === undefined) {
      job.resolve(first.value);
      return;
    }
    if (this.#discarding) {
      this.#drop(job);
      return;
    }
    this.#requeueHead(chat, { ...job, ...next, rest, first, attempts: 0 });
  }

  #handleFailure(chat: ChatState, job: Job, error: unknown): void {
    const now = this.#config.clock();
    const hint = this.#discarding ? undefined : retryAfter(error);
    // Janela global (429 global): nenhum chat envia antes dela, nem quando este envio não
    // re-tenta. Mandar antes só gastaria requisições recusadas, que a plataforma também pune.
    if (hint?.global === true) {
      this.#globalReadyAt = Math.max(this.#globalReadyAt, now + hint.ms);
    }
    // Descartando, não re-tenta; pausada além do teto, a re-tentativa ficaria parada sem previsão.
    let delay: number | null = null;
    if (!this.#discarding && !this.#offline) {
      try {
        delay = retryDelay(error, job.attempts, hint, this.#config.retry, this.#config.random);
      } catch (hookError) {
        this.#failed++;
        job.reject(new AggregateError([hookError, error], 'retry.isRetryable lançou'));
        return;
      }
    }
    if (delay === null) {
      this.#failed++;
      job.reject(error);
      return;
    }
    this.#retries++;
    if (job.track !== undefined) job.track.retries++;
    this.#requeueHead(chat, job);
    chat.readyAt = Math.max(chat.readyAt, now + delay);
  }

  /**
   * Põe o job na frente do chat (re-tentativa ou parte seguinte de um texto dividido). Os dois
   * contadores andam juntos: `stats()`, `maxPending` e `onIdle()` dependem deles.
   */
  #requeueHead(chat: ChatState, job: Job): void {
    chat.head = job;
    chat.pending++;
    this.#pendingBy[job.priority]++;
  }

  /**
   * Corre `operation` contra `sendTimeoutMs`. O resultado tardio é ignorado de propósito: quem
   * chamou `send` já recebeu o `'timeout'`, e o `race` mantém um handler na promise original.
   */
  #withTimeout<T>(operation: Promise<T>, what: string): Promise<T> {
    if (this.#config.sendTimeoutMs === Number.POSITIVE_INFINITY) return operation;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const message = `${what}: transport sem resposta em ${this.#config.sendTimeoutMs} ms`;
        reject(new OutboundQueueError('timeout', message));
      }, this.#config.sendTimeoutMs);
    });
    return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
  }

  async #simulate(
    chatId: string,
    content: OutgoingContent,
    humanize: Required<HumanizeOptions>,
  ): Promise<void> {
    let kind: TypingKind;
    let ms: number;
    if (content.type === 'text') {
      kind = 'text';
      ms = Math.min(
        humanize.maxMs,
        Math.max(humanize.minMs, content.text.length * humanize.msPerChar),
      );
    } else if (content.type === 'voice') {
      kind = 'voice';
      ms = humanize.maxMs;
    } else {
      return;
    }
    try {
      await this.#withTimeout(this.#transport.sendTyping(chatId, kind), `"digitando" em ${chatId}`);
    } catch (error) {
      // O indicador é cosmético: a falha vai para o destino configurado e o envio segue já.
      this.#config.onTypingError?.(error, chatId);
      return;
    }
    if (ms > 0 && !this.#discarding) await this.#sleep(ms);
  }

  /** Espera `ms`, ou menos se a fila for descartada antes. */
  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#sleepers.add(done);
    });
  }

  #discard(): void {
    this.#discarding = true;
    clearTimeout(this.#pauseTimer);
    this.#pauseTimer = undefined;
    for (const done of this.#sleepers) done();
    this.#rejectWaiting(discardedError);
  }

  /** Descarta, sem enviar, um job que já saiu da espera. */
  #drop(job: Job): void {
    this.#dropped++;
    job.reject(discardedError());
  }

  /** Rejeita tudo o que aguarda, inclusive re-tentativas; os envios em andamento seguem. */
  #rejectWaiting(error: () => OutboundQueueError): void {
    for (const chat of this.#chats.values()) {
      const waiting: Job[] = chat.head === null ? [] : [chat.head];
      for (const fifo of chat.jobs) {
        for (let job = fifo.shift(); job !== undefined; job = fifo.shift()) waiting.push(job);
      }
      for (const job of waiting) {
        this.#dropped++;
        job.reject(error());
      }
      chat.head = null;
      chat.pending = 0;
      chat.ticket = 0;
      clearTimeout(chat.timer);
      chat.timer = undefined;
      if (!chat.busy) this.#chats.delete(chat.id);
    }
    this.#pendingBy[0] = 0;
    this.#pendingBy[1] = 0;
    this.#pendingBy[2] = 0;
    for (const list of this.#ready) list.clear();
    clearTimeout(this.#globalTimer);
    this.#globalTimer = undefined;
    this.#notifyIdle();
  }

  #notifyIdle(): void {
    if (this.#chats.size > 0 || this.#idleWaiters.length === 0) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

function firstNonEmpty(jobs: ChatState['jobs']): PriorityIndex | -1 {
  if (jobs[0].size > 0) return 0;
  if (jobs[1].size > 0) return 1;
  return jobs[2].size > 0 ? 2 : -1;
}

function discardedError(): OutboundQueueError {
  return new OutboundQueueError('closed', 'fila de saída fechada sem drenar: envio descartado');
}
