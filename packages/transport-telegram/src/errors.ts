// Erros da Bot API no formato que o core entende: o motivo da queda (ADR 0064) e os campos de
// re-tentativa da fila de saída (ADR 0063). O core não lê código de plataforma.

import type { DisconnectReason } from '@usebridger/core';
import { MediaExpiredError } from '@usebridger/core';
import { GrammyError } from 'grammy';

/** Por que o `bot.start()` rejeitou. O grammY só para o polling sozinho em 401 e 409. */
export function toDisconnectReason(error: unknown): DisconnectReason {
  if (error instanceof GrammyError) {
    if (error.error_code === 401) return 'auth-failed';
    // O `start()` apaga o webhook antes: o 409 é outro `getUpdates` com o mesmo token.
    if (error.error_code === 409) return 'replaced';
  }
  return 'connection-lost';
}

/**
 * Enriquece o erro da API para a fila de saída: 429 com a espera da plataforma e os 4xx como
 * permanentes. Falha de rede (`HttpError`) e 5xx seguem sem campo, e a fila re-tenta com backoff.
 */
export function classify(error: unknown): unknown {
  if (!(error instanceof GrammyError)) return error;
  const code = error.error_code;
  if (code === 429) {
    const seconds = error.parameters.retry_after;
    return seconds === undefined ? error : Object.assign(error, { retryAfterMs: seconds * 1000 });
  }
  if (code >= 400 && code < 500) return Object.assign(error, { retryable: false });
  return error;
}

/** Roda uma chamada à API com o erro já classificado. */
export async function call<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw classify(error);
  }
}

/**
 * O `file_id` que o Telegram não reconhece mais (ADR 0136). O "file is too big" (acima de 20 MB
 * na Bot API) não é expiração: segue como erro comum.
 */
export function expiredOr(error: unknown): unknown {
  if (
    error instanceof GrammyError &&
    error.error_code === 400 &&
    /file_id|file reference/i.test(error.description)
  ) {
    return new MediaExpiredError('telegram: o Telegram não tem mais esta mídia', { cause: error });
  }
  return error;
}
