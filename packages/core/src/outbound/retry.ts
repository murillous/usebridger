// Política de retry da fila de saída (ADR 0017 e 0063), sem estado: a fila guarda as tentativas,
// as janelas e os contadores, e pergunta aqui se re-tenta e com que espera.

import { UnsupportedError } from '#transport/capabilities.ts';
import { OutboundQueueError } from './errors.ts';

/** `RetryOptions` com os padrões aplicados e validados. */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly isRetryable: (error: unknown) => boolean;
}

/** Janela informada pela plataforma num erro do transport. */
export interface RetryAfter {
  readonly ms: number;
  /** Vale para todos os chats (429 global), e não só para o do envio. */
  readonly global: boolean;
}

/**
 * Janela que a plataforma informou num erro do transport (ADR 0063): `retryAfterMs` finito e
 * >= 0, e `retryAfterScope: 'global'` quando ela vale para todos os chats. Duck typing, como o
 * `retryable`: o transport não precisa de classe do core para lançar o erro nativo enriquecido.
 */
export function retryAfter(error: unknown): RetryAfter | undefined {
  if (typeof error !== 'object' || error === null || !('retryAfterMs' in error)) return undefined;
  const ms = error.retryAfterMs;
  if (typeof ms !== 'number' || !(Number.isFinite(ms) && ms >= 0)) return undefined;
  return { ms, global: 'retryAfterScope' in error && error.retryAfterScope === 'global' };
}

/** `isRetryable` padrão: tudo, exceto `UnsupportedError` e erros com `retryable: false`. */
export function isTransient(error: unknown): boolean {
  if (error instanceof UnsupportedError) return false;
  return !(
    typeof error === 'object' &&
    error !== null &&
    'retryable' in error &&
    error.retryable === false
  );
}

/** Exponencial com teto e jitter "igual": metade fixa, metade aleatória. */
export function backoffDelay(
  failures: number,
  policy: Pick<RetryPolicy, 'baseDelayMs' | 'maxDelayMs'>,
  random: () => number,
): number {
  const capped = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (failures - 1));
  return capped / 2 + (capped / 2) * random();
}

/**
 * Espera até a re-tentativa do envio que falhou na tentativa `attempts`, ou `null` se não
 * re-tenta. `hint` é a janela do erro (`retryAfter`). Lança o que `policy.isRetryable` lançar.
 */
export function retryDelay(
  error: unknown,
  attempts: number,
  hint: RetryAfter | undefined,
  policy: RetryPolicy,
  random: () => number,
): number | null {
  // Prazo estourado não re-tenta: o transport pode ainda entregar, e reenviar duplicaria. Janela
  // acima do teto de espera também não: a resposta sairia fora de contexto.
  if (
    error instanceof OutboundQueueError ||
    attempts >= policy.maxAttempts ||
    (hint !== undefined && hint.ms > policy.maxDelayMs) ||
    !policy.isRetryable(error)
  ) {
    return null;
  }
  // A janela informada pela plataforma é exata: sem jitter, e no lugar do backoff, que
  // tentaria cedo demais e gastaria as tentativas antes de ela abrir.
  return hint === undefined ? backoffDelay(attempts, policy, random) : hint.ms;
}
