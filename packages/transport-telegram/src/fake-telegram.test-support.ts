// Telegram falso para os testes: um `Bot` do grammY de verdade, com um transformer que responde
// às chamadas da API em memória. O `getUpdates` entrega os updates de `push()` e fica pendurado
// até o próximo ou até o `stop()` abortar, como o long polling real.

import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import type { TelegramDriver } from './transport.ts';

export interface Call {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

/** Resposta de erro da Bot API, que o grammY converte em `GrammyError`. */
export interface ApiFailure {
  readonly ok: false;
  readonly error_code: number;
  readonly description: string;
  readonly parameters?: { readonly retry_after?: number };
}

export function failure(
  error_code: number,
  description: string,
  parameters?: ApiFailure['parameters'],
): ApiFailure {
  return { ok: false, error_code, description, ...(parameters && { parameters }) };
}

export const BOT_USER = {
  id: 42,
  is_bot: true,
  first_name: 'Bot',
  username: 'fake_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

type Handler = (payload: Record<string, unknown>) => unknown;

export class FakeTelegram {
  readonly calls: Call[] = [];
  /** Respostas por método; devolver um `ApiFailure` vira erro da API. */
  readonly handlers: Map<string, Handler> = new Map();
  /** Arquivos por `file_path`, para o download. */
  readonly files: Map<string, Buffer> = new Map();
  #updates: Update[] = [];
  #wake: (() => void) | undefined;
  #nextUpdate = 1;
  #nextMessage = 1000;

  readonly driver: TelegramDriver = {
    makeBot: () => {
      const bot = new Bot('42:fake-token');
      // O transformer é genérico por método: a resposta montada aqui não tem o tipo de cada um.
      const transformer = (
        _prev: unknown,
        method: string,
        payload: unknown,
        signal: unknown,
      ): Promise<unknown> =>
        this.#handle(
          method,
          (payload ?? {}) as Record<string, unknown>,
          signal as AbortSignal | undefined,
        );
      bot.api.config.use(transformer as Parameters<typeof bot.api.config.use>[0]);
      return bot;
    },
    fetchFile: async (filePath) => {
      const file = this.files.get(filePath);
      return file === undefined ? new Response(null, { status: 404 }) : new Response(file);
    },
  };

  /**
   * Entrega um update ao próximo `getUpdates`; o `update_id` é preenchido aqui. Sem o tipo do
   * grammY: as uniões da Bot API (`ReplyMessage`, `NonChannel`) não deixam montar fixtures parciais.
   */
  push(update: Record<string, unknown>): void {
    this.#updates.push({ ...update, update_id: this.#nextUpdate++ } as Update);
    this.#wake?.();
  }

  callsTo(method: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.payload);
  }

  async #handle(
    method: string,
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    this.calls.push({ method, payload });
    const handler = this.handlers.get(method);
    if (handler !== undefined) {
      const result = await handler(payload);
      if (isFailure(result)) return result;
      return { ok: true, result };
    }
    if (method === 'getUpdates') return { ok: true, result: await this.#poll(payload, signal) };
    return { ok: true, result: this.#default(method, payload) };
  }

  async #poll(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Update[]> {
    // A confirmação do offset no `stop()` vem sem `timeout` e responde na hora.
    if (payload['timeout'] === undefined) return [];
    while (this.#updates.length === 0) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        this.#wake = resolve;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return this.#updates.splice(0);
  }

  #default(method: string, payload: Record<string, unknown>): unknown {
    if (method === 'getMe') return BOT_USER;
    if (method.startsWith('send')) {
      return {
        message_id: this.#nextMessage++,
        date: 1_760_000_000,
        chat: { id: payload['chat_id'], type: 'private', first_name: 'X' },
        text: '',
      };
    }
    return true;
  }
}

function isFailure(value: unknown): value is ApiFailure {
  return typeof value === 'object' && value !== null && (value as ApiFailure).ok === false;
}
