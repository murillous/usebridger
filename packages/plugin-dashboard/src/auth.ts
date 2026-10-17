import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE = 'bridger_dashboard';

const sha256 = (text: string): Buffer => createHash('sha256').update(text).digest();

/** Compara em tempo constante: o hash iguala o tamanho e esconde o comprimento do token. */
export function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  return timingSafeEqual(sha256(given), sha256(expected));
}

function readCookie(request: Request): string | undefined {
  const header = request.headers.get('cookie');
  if (header === null) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return undefined;
}

export interface Sessions {
  /** Abre uma sessão e devolve o valor opaco do cookie (nunca o token da config). */
  create(): string;
  valid(request: Request): boolean;
  destroy(request: Request): void;
  clear(): void;
}

/** Sessões em memória: reiniciar o bot desloga todo mundo, de propósito. */
export function createSessions(maxAgeSec: number, now: () => number = Date.now): Sessions {
  const sessions = new Map<string, number>();
  const purge = (): void => {
    for (const [id, expires] of sessions) if (expires <= now()) sessions.delete(id);
  };
  return {
    create() {
      purge();
      const id = randomBytes(32).toString('base64url');
      sessions.set(id, now() + maxAgeSec * 1000);
      return id;
    },
    valid(request) {
      const id = readCookie(request);
      if (id === undefined) return false;
      const expires = sessions.get(id);
      if (expires === undefined) return false;
      if (expires <= now()) {
        sessions.delete(id);
        return false;
      }
      return true;
    },
    destroy(request) {
      const id = readCookie(request);
      if (id !== undefined) sessions.delete(id);
    },
    clear: () => sessions.clear(),
  };
}

/** Origin presente precisa ser do mesmo host do pedido (CSWSH); sem Origin (cliente não-browser) passa. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  try {
    return new URL(origin).host.toLowerCase() === request.headers.get('host')?.toLowerCase();
  } catch {
    return false;
  }
}
