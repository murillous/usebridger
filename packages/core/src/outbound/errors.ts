export type OutboundQueueErrorReason = 'full' | 'closed' | 'disconnected' | 'timeout';

/**
 * Envio recusado ou abandonado pela fila: backlog cheio, fila fechada, conexão caída além de
 * `maxPauseMs` ou transport sem resposta em `sendTimeoutMs`.
 */
export class OutboundQueueError extends Error {
  override readonly name = 'OutboundQueueError';
  readonly reason: OutboundQueueErrorReason;

  constructor(reason: OutboundQueueErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}
