import type { LiveMessage, LogEntry, StatusView } from './types.ts';

export const MAX_LOGS = 500;

export interface LiveState {
  status: StatusView | null;
  logs: LogEntry[];
  /** WS aberto agora. Falso = o que se vê está desatualizado. */
  connected: boolean;
  /** Hora (ms) da última mensagem recebida. */
  lastUpdate: number | null;
}

export const initialLive: LiveState = {
  status: null,
  logs: [],
  connected: false,
  lastUpdate: null,
};

/** Aplica uma mensagem do servidor ao estado. Pura: o hook só repassa. */
export function reduceLive(state: LiveState, message: LiveMessage, now: number): LiveState {
  const base = { ...state, lastUpdate: now };
  switch (message.type) {
    case 'snapshot':
      return { ...base, status: message.status, logs: message.logs.slice(-MAX_LOGS) };
    case 'status': {
      const { type: _type, ...status } = message;
      return { ...base, status };
    }
    case 'qr':
      return state.status ? { ...base, status: { ...state.status, qr: message.qr } } : base;
    case 'pairing-code':
      return state.status
        ? { ...base, status: { ...state.status, pairingCode: message.code } }
        : base;
    case 'log':
      return { ...base, logs: [...state.logs, message.entry].slice(-MAX_LOGS) };
  }
}

/** Espera antes da tentativa `attempt` (0, 1, ...): 1 s, 2 s, 4 s... até 15 s. */
export const backoffDelay = (attempt: number): number => Math.min(1000 * 2 ** attempt, 15_000);

export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  close(): void;
}

export interface LiveClientOptions {
  open(): SocketLike;
  onMessage(message: LiveMessage): void;
  onConnection(connected: boolean): void;
  /** Injetável nos testes; devolve o cancelamento. */
  schedule?(run: () => void, ms: number): () => void;
}

const defaultSchedule = (run: () => void, ms: number): (() => void) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};

/** WebSocket com reconexão por backoff exponencial; cada reconexão recebe novo snapshot do servidor. */
export function createLiveClient(options: LiveClientOptions): { close(): void } {
  const schedule = options.schedule ?? defaultSchedule;
  let attempt = 0;
  let stopped = false;
  let socket: SocketLike | undefined;
  let cancel: (() => void) | undefined;

  const connect = (): void => {
    const current = options.open();
    socket = current;
    current.onopen = () => {
      attempt = 0;
      options.onConnection(true);
    };
    current.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let message: LiveMessage;
      try {
        message = JSON.parse(event.data) as LiveMessage;
      } catch {
        // Mensagem fora do contrato: ignora; o próximo snapshot reconcilia.
        return;
      }
      options.onMessage(message);
    };
    current.onclose = () => {
      options.onConnection(false);
      if (stopped) return;
      cancel = schedule(connect, backoffDelay(attempt++));
    };
  };

  connect();
  return {
    close() {
      stopped = true;
      cancel?.();
      socket?.close();
    },
  };
}
