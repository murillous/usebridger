// Horário de conexão, reconexões e expiração do QR de um bot (ADR 0114). Alimentado pelo
// `transport-entry` no mesmo ponto do `recordStatus`, então não diverge do barramento.

import type { ConnectionStatus } from '#transport/types.ts';

export interface ConnectionInfo {
  /** Quando a conexão atual abriu (ms epoch); `undefined` fora do ar. */
  readonly connectedSince: number | undefined;
  /** Quantas vezes a conexão reabriu depois da primeira abertura. */
  readonly reconnections: number;
  /** Quando o QR de pareamento atual expira (ms epoch); `undefined` sem QR ou sem expiração. */
  readonly qrExpiresAt: number | undefined;
}

export interface ConnectionTracker {
  onStatus(status: ConnectionStatus): void;
  onQr(expiresAt: number | undefined): void;
  info(): ConnectionInfo;
}

export function createConnectionTracker(now: () => number = Date.now): ConnectionTracker {
  let connectedSince: number | undefined;
  let opens = 0;
  let qrExpiresAt: number | undefined;
  return {
    onStatus(status) {
      if (status.status === 'open') {
        // Um `open` repetido sem queda no meio não é reconexão nem muda o horário.
        if (connectedSince === undefined) {
          connectedSince = now();
          opens += 1;
        }
        qrExpiresAt = undefined;
      } else if (status.status === 'closed') {
        connectedSince = undefined;
        qrExpiresAt = undefined;
      }
    },
    onQr(expiresAt) {
      qrExpiresAt = expiresAt;
    },
    info: () => ({ connectedSince, reconnections: Math.max(0, opens - 1), qrExpiresAt }),
  };
}
