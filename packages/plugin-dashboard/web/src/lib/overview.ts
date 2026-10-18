// Regras da Visão geral que não dependem de React: a tela só desenha.
import type { LogEntry, StatusView } from './types.ts';

export interface BotChip {
  label: string;
  tone: 'ok' | 'warn' | 'danger';
}

// Só estes `reason` fazem o core parar de reconectar (reconnection.ts, ADR 0068); nos outros o
// kernel reconecta sozinho. `auth-failed` só é terminal sem pareamento: com ele o core limpa a
// sessão e reconecta (reconnection.ts).
export const isFatal = (status: StatusView): boolean =>
  status.status === 'closed' &&
  (status.reason === 'fatal' ||
    status.reason === 'replaced' ||
    (status.reason === 'auth-failed' && !status.pairing));

/** Chip do card do bot: QR ou código de pareamento pendente vira "Aguardando pareamento". */
export function botChip(status: StatusView): BotChip {
  if (status.status === 'open') return { label: 'Conectado', tone: 'ok' };
  if (status.status === 'closed') {
    return isFatal(status)
      ? { label: 'Erro fatal', tone: 'danger' }
      : { label: 'Reconectando', tone: 'warn' };
  }
  if (status.qr || status.pairingCode) return { label: 'Aguardando pareamento', tone: 'warn' };
  return { label: 'Conectando', tone: 'warn' };
}

/** Rótulo PT-BR do estado do transport, no lugar do valor cru. */
export const stateLabel = (status: StatusView): string =>
  status.status === 'open'
    ? 'Em execução'
    : status.status === 'connecting'
      ? 'Conectando'
      : isFatal(status)
        ? 'Parado'
        : 'Reconectando';

/** Origem da linha de log: o campo `plugin` quando o logger filho o põe; senão `core`. */
export function logOrigin(entry: LogEntry): string {
  const fields = entry.fields;
  if (fields && typeof fields === 'object' && 'plugin' in fields) {
    const plugin = (fields as { plugin: unknown }).plugin;
    if (typeof plugin === 'string' && plugin) return plugin;
  }
  return 'core';
}

/** As `n` linhas mais novas primeiro (o card mostra o que acabou de acontecer). */
export const recentLogs = (logs: LogEntry[], n: number): LogEntry[] => logs.slice(-n).reverse();
