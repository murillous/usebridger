// Limite de tentativas de login por chave (IP e e-mail): 5 falhas em 15 min bloqueiam, e cada falha
// seguinte dobra a espera (ADR 0127). Conta o e-mail digitado, exista ele ou não, para o 429 não
// revelar se a conta existe.
// shortcut: em memória do processo (reinicia zerado e não divide entre instâncias); mover para o
// storage se rodar mais de uma instância na frente da mesma API.

export interface LoginLimiterOptions {
  readonly now?: () => Date;
  readonly maxFailures?: number;
  readonly windowMs?: number;
  /** Espera após a falha que atinge o limite; dobra a cada falha seguinte. */
  readonly baseWaitMs?: number;
  readonly maxWaitMs?: number;
}

export interface LoginLimiter {
  /** Milissegundos até poder tentar de novo (0 = liberado) para a pior das chaves. */
  wait(keys: readonly string[]): number;
  fail(keys: readonly string[]): void;
  /** Desfaz uma falha reservada (a tentativa deu certo ou nem chegou a verificar). */
  refund(keys: readonly string[]): void;
  reset(key: string): void;
}

interface Entry {
  count: number;
  since: number;
  blockedUntil: number;
}

export function createLoginLimiter(options: LoginLimiterOptions = {}): LoginLimiter {
  const now = options.now ?? (() => new Date());
  const max = options.maxFailures ?? 5;
  const windowMs = options.windowMs ?? 15 * 60_000;
  const baseMs = options.baseWaitMs ?? 30_000;
  const capMs = options.maxWaitMs ?? 60 * 60_000;
  const entries = new Map<string, Entry>();

  function prune(at: number): void {
    if (entries.size < 10_000) return;
    for (const [key, entry] of entries) {
      if (entry.blockedUntil <= at && at - entry.since > windowMs) entries.delete(key);
    }
  }

  return {
    wait: (keys) => {
      const at = now().getTime();
      return Math.max(0, ...keys.map((key) => (entries.get(key)?.blockedUntil ?? 0) - at));
    },
    fail: (keys) => {
      const at = now().getTime();
      prune(at);
      for (const key of keys) {
        let entry = entries.get(key);
        // Janela vencida e sem bloqueio: recomeça a contagem.
        if (entry === undefined || (entry.blockedUntil <= at && at - entry.since > windowMs)) {
          entry = { count: 0, since: at, blockedUntil: 0 };
          entries.set(key, entry);
        }
        entry.count += 1;
        if (entry.count >= max) {
          entry.blockedUntil = at + Math.min(baseMs * 2 ** (entry.count - max), capMs);
        }
      }
    },
    refund: (keys) => {
      for (const key of keys) {
        const entry = entries.get(key);
        if (entry === undefined) continue;
        entry.count = Math.max(0, entry.count - 1);
        if (entry.count < max) entry.blockedUntil = 0;
      }
    },
    reset: (key) => {
      entries.delete(key);
    },
  };
}
