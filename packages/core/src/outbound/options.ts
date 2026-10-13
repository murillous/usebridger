// Validação e padrões das opções da fila de saída, separados do estado da fila.

import { hasCapability } from '#transport/capabilities.ts';
import type { TransportPacing } from '#transport/types.ts';
import type { HumanizeOptions, OutboundQueueOptions, OutboundTransport } from './queue.ts';
import { isTransient, type RetryPolicy } from './retry.ts';

/** `OutboundQueueOptions` validadas e com os padrões aplicados; o `transport` fica de fora. */
export interface OutboundConfig {
  readonly globalIntervalMs: number;
  readonly chatIntervalMs: number;
  readonly maxPending: number;
  readonly retry: RetryPolicy;
  /** `null`: humanização desligada ou transport sem a capability `typing`. */
  readonly humanize: Readonly<Required<HumanizeOptions>> | null;
  readonly onTypingError: ((error: unknown, chatId: string) => void) | undefined;
  readonly maxPauseMs: number;
  readonly sendTimeoutMs: number;
  readonly clock: () => number;
  readonly random: () => number;
}

const DEFAULTS = {
  globalIntervalMs: 300,
  chatIntervalMs: 1000,
  maxPending: 1000,
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  maxPauseMs: 60_000,
  sendTimeoutMs: 30_000,
  msPerChar: 50,
  minMs: 500,
  maxMs: 3000,
} as const;

/** Valida as opções e aplica os padrões. Lança `RangeError` no primeiro valor inválido. */
export function resolveOutboundOptions(options: OutboundQueueOptions): OutboundConfig {
  const retry = options.retry ?? {};
  // O ritmo é da plataforma (ADR 0067): a config do bot sobrescreve o do transport, e sem
  // nenhum dos dois vale o padrão anti-ban do WhatsApp (ADR 0019).
  const pacing = options.transport.pacing;
  const globalIntervalMs = pace('globalIntervalMs', options.globalIntervalMs, pacing);
  const chatIntervalMs = pace('chatIntervalMs', options.chatIntervalMs, pacing);
  const maxPending = options.maxPending ?? DEFAULTS.maxPending;
  if (
    !(maxPending === Number.POSITIVE_INFINITY || (Number.isInteger(maxPending) && maxPending >= 0))
  ) {
    throw new RangeError(`maxPending deve ser inteiro >= 0 ou Infinity (recebido: ${maxPending})`);
  }
  const maxAttempts = retry.maxAttempts ?? DEFAULTS.maxAttempts;
  if (!(Number.isInteger(maxAttempts) && maxAttempts >= 1)) {
    throw new RangeError(`retry.maxAttempts deve ser inteiro >= 1 (recebido: ${maxAttempts})`);
  }
  const baseDelayMs = nonNegative('retry.baseDelayMs', retry.baseDelayMs ?? DEFAULTS.baseDelayMs);
  const maxDelayMs = nonNegative('retry.maxDelayMs', retry.maxDelayMs ?? DEFAULTS.maxDelayMs);
  const humanize = resolveHumanize(options.humanize, options.transport);
  const maxPauseMs = options.maxPauseMs ?? DEFAULTS.maxPauseMs;
  if (!(maxPauseMs >= 0)) {
    throw new RangeError(`maxPauseMs deve ser >= 0 ou Infinity (recebido: ${maxPauseMs})`);
  }
  const sendTimeoutMs = options.sendTimeoutMs ?? DEFAULTS.sendTimeoutMs;
  if (!(sendTimeoutMs > 0)) {
    throw new RangeError(`sendTimeoutMs deve ser > 0 ou Infinity (recebido: ${sendTimeoutMs})`);
  }
  return Object.freeze({
    globalIntervalMs,
    chatIntervalMs,
    maxPending,
    retry: Object.freeze({
      maxAttempts,
      baseDelayMs,
      maxDelayMs,
      isRetryable: retry.isRetryable ?? isTransient,
    }),
    humanize,
    onTypingError: options.onTypingError,
    maxPauseMs,
    sendTimeoutMs,
    clock: options.clock ?? (() => performance.now()),
    random: options.random ?? Math.random,
  });
}

function nonNegative(name: string, value: number): number {
  if (!(Number.isFinite(value) && value >= 0)) {
    throw new RangeError(`${name} deve ser um número finito >= 0 (recebido: ${value})`);
  }
  return value;
}

function pace(
  name: keyof TransportPacing,
  configured: number | undefined,
  pacing: TransportPacing | undefined,
): number {
  if (configured !== undefined) return nonNegative(name, configured);
  const fromTransport = pacing?.[name];
  if (fromTransport !== undefined) return nonNegative(`transport.pacing.${name}`, fromTransport);
  return DEFAULTS[name];
}

function resolveHumanize(
  option: boolean | HumanizeOptions | undefined,
  transport: OutboundTransport,
): Readonly<Required<HumanizeOptions>> | null {
  // Capabilities são fixas na vida do transport: decide uma vez, não a cada envio.
  if (option === undefined || option === false || !hasCapability(transport, 'typing')) {
    return null;
  }
  const custom = option === true ? {} : option;
  return Object.freeze({
    msPerChar: nonNegative('humanize.msPerChar', custom.msPerChar ?? DEFAULTS.msPerChar),
    minMs: nonNegative('humanize.minMs', custom.minMs ?? DEFAULTS.minMs),
    maxMs: nonNegative('humanize.maxMs', custom.maxMs ?? DEFAULTS.maxMs),
  });
}
