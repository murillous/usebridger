// Observadores do core (ADR 0102): sinais por unidade de trabalho para métricas, síncronos e
// nunca aguardados. Não usam o barramento, cujo listener segura o chat, nem o
// `diagnostics_channel`, que é global ao processo.

import type { PluginErrorEvent } from '#events/types.ts';
import type { LogFields, LogLevel } from '#logger/types.ts';
import type { Unsubscribe } from '#transport/types.ts';

/** Mensagem que o bot terminou de tratar: o comando, o passo ou os listeners de `message`. */
export interface MessageHandledSignal {
  readonly messageId: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly chatType: 'group' | 'private';
  /** O que consumiu a mensagem. */
  readonly route: 'command' | 'step' | 'message';
  /** Nome canônico do comando, nunca o `invokedAs`. */
  readonly command?: string;
  readonly status: 'ok' | 'failed' | 'refused' | 'timeout';
  /** Espera na fila de entrada do chat, em ms. */
  readonly queuedMs: number;
  /** Tempo do handler (comando, passo ou listeners de `message`), em ms. */
  readonly durationMs: number;
}

/** Envio que saiu da fila de saída: enviado, falho ou descartado. */
export interface OutboundSentSignal {
  readonly chatId: string;
  /** Presente só na resposta por `ctx.reply`: o `ctx.send` recebe apenas o id do chat. */
  readonly chatType?: 'group' | 'private';
  /** Tipo do conteúdo: `text`, `image`, `sticker`, `album`... */
  readonly kind: string;
  readonly status: 'sent' | 'failed' | 'dropped';
  /** Espera na fila de saída, inclusive taxa anti-ban e re-tentativas, em ms. */
  readonly queuedMs: number;
  readonly retries: number;
  /** `messageId` da mensagem que originou a resposta, quando o envio veio do `ctx.reply`. */
  readonly replyTo?: string;
}

/** Linha de log que passou do nível do logger do bot, com segredos já mascarados. */
export interface LogSignal {
  readonly level: Exclude<LogLevel, 'silent'>;
  /** `Date.now()` de quando a linha foi emitida. */
  readonly time: number;
  readonly message: string;
  /** Campos da chamada mais os bindings do logger filho (`plugin`, `chat`, `transport`...). */
  readonly fields: LogFields;
}

export interface ObserverSignals {
  readonly 'message.handled': MessageHandledSignal;
  readonly 'outbound.sent': OutboundSentSignal;
  readonly log: LogSignal;
}

export type ObserverSignalName = keyof ObserverSignals;

export type Observer<S extends ObserverSignalName> = (signal: ObserverSignals[S]) => void;

interface Entry {
  readonly plugin: string;
  readonly fn: (signal: never) => void;
}

/** Registro de observadores de um `Bot`. */
export class Observers {
  // Copiadas a cada mudança: quem emite itera a lista do momento, mesmo que um observador saia.
  readonly #lists: Record<ObserverSignalName, readonly Entry[]> = {
    'message.handled': [],
    'outbound.sent': [],
    log: [],
  };
  readonly #onError: (event: PluginErrorEvent) => void;

  constructor(onError: (event: PluginErrorEvent) => void) {
    this.#onError = onError;
  }

  /** O guarda do caminho quente: sem observador, quem emite não lê o relógio nem monta o sinal. */
  has(signal: ObserverSignalName): boolean {
    return this.#lists[signal].length !== 0;
  }

  add<S extends ObserverSignalName>(plugin: string, signal: S, fn: Observer<S>): Unsubscribe {
    if (!Object.hasOwn(this.#lists, signal)) {
      throw new TypeError(`plugin "${plugin}": sinal desconhecido "${String(signal)}"`);
    }
    if (typeof fn !== 'function') {
      throw new TypeError(`plugin "${plugin}": observador de "${signal}" não é função`);
    }
    const entry: Entry = { plugin, fn };
    this.#lists[signal] = [...this.#lists[signal], entry];
    return () => {
      this.#lists[signal] = this.#lists[signal].filter((other) => other !== entry);
    };
  }

  removePlugin(plugin: string): void {
    for (const signal of Object.keys(this.#lists) as ObserverSignalName[]) {
      this.#lists[signal] = this.#lists[signal].filter((entry) => entry.plugin !== plugin);
    }
  }

  /** Chama cada observador; a exceção de um vira `plugin.error` e os demais seguem. */
  emit<S extends ObserverSignalName>(signal: S, payload: ObserverSignals[S]): void {
    for (const { plugin, fn } of this.#lists[signal]) {
      try {
        const result: unknown = (fn as Observer<S>)(payload);
        // Não aguarda, mas trata a rejeição: solta, ela vira `unhandledRejection` e derruba o
        // processo.
        if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') {
          (result as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.#onError({ plugin, phase: 'observer', event: signal, error, timedOut: false });
          });
        }
      } catch (error) {
        this.#onError({ plugin, phase: 'observer', event: signal, error, timedOut: false });
      }
    }
  }
}
