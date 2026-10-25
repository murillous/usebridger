// Pseudônimo estável de usuário/grupo para logs (ADR 0119): HMAC-SHA256 do id com uma chave
// derivada (HKDF) da chave mestra dos segredos (ADR 0117), truncado em 16 bytes. Só vai do id ao
// pseudônimo; nunca volta.

import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { LogFields, Logger } from './types.ts';

/** `user` vira `u_…`; `group` vira `g_…`. */
export type PseudonymKind = 'user' | 'group';

/** Pseudônimo de um id; sem `kind`, `@g.us` e id começado em `-` são grupo, o resto usuário. */
export type Pseudonym = (id: string, kind?: PseudonymKind) => string;

// Rótulo próprio: a chave de pseudônimo não serve para cifrar segredo, nem o contrário.
const HKDF_INFO = 'bridger-pseudonym-v1';
const TRUNCATE_BYTES = 16;
const SHAPE_RE = /^[ug]_[A-Za-z0-9_-]{22}$/;

/** Deriva uma subchave de 32 bytes da chave mestra; cada uso tem o próprio rótulo `info`. */
export function deriveSubkey(master: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
}

/** Deriva a chave de pseudônimo da chave mestra (32 bytes). */
export function derivePseudonymKey(master: Buffer): Buffer {
  return deriveSubkey(master, HKDF_INFO);
}

// Transport-agnóstico só no que dá: JID de grupo do WhatsApp e id negativo (Telegram) são grupo.
/** Tipo padrão de um id sem `kind`. */
export const guessKind = (id: string): PseudonymKind =>
  id.endsWith('@g.us') || id.startsWith('-') ? 'group' : 'user';

/** Pseudônimo com a chave já derivada; sem `kind`, o tipo vem do formato do id. */
export function pseudonymWith(key: Buffer): Pseudonym {
  return (id, kind = guessKind(id)) =>
    `${kind === 'group' ? 'g_' : 'u_'}${createHmac('sha256', key)
      .update(id)
      .digest()
      .subarray(0, TRUNCATE_BYTES)
      .toString('base64url')}`;
}

export interface Pseudonymizer {
  readonly pseudonym: Pseudonym;
  /**
   * Resolve a chave agora e diz se ela é efêmera (sem chave mestra: pseudônimos mudam a cada
   * restart). Lança o que `masterKey` lançar (chave mestra malformada).
   */
  ephemeral(): boolean;
}

/**
 * `masterKey` é lida na primeira chamada, não na criação: o bot só vê o ambiente no start. Sem
 * chave mestra, a chave é aleatória do processo (estável só até o restart).
 */
export function createPseudonymizer(masterKey: () => Buffer | undefined): Pseudonymizer {
  let resolved: { readonly fn: Pseudonym; readonly ephemeral: boolean } | undefined;
  const resolve = (): NonNullable<typeof resolved> => {
    if (resolved === undefined) {
      const master = masterKey();
      resolved = master
        ? { fn: pseudonymWith(derivePseudonymKey(master)), ephemeral: false }
        : { fn: pseudonymWith(randomBytes(32)), ephemeral: true };
    }
    return resolved;
  };
  return { pseudonym: (id, kind) => resolve().fn(id, kind), ephemeral: () => resolve().ephemeral };
}

function mapFields(fields: LogFields, pseudonym: Pseudonym): LogFields {
  let out = fields;
  for (const key of ['chat', 'sender'] as const) {
    const value = fields[key];
    if (typeof value !== 'string' || SHAPE_RE.test(value)) continue;
    if (out === fields) out = { ...fields };
    (out as Record<string, unknown>)[key] = pseudonym(value);
  }
  return out;
}

/**
 * Logger que troca os campos `chat` e `sender` (em chamadas e em bindings) por pseudônimo. Um
 * valor que já é pseudônimo (de `ctx.pseudonym`) passa como está. Os demais campos seguem.
 */
export function withPseudonyms(log: Logger, pseudonym: Pseudonym): Logger {
  const map = (fields: LogFields | undefined): LogFields | undefined =>
    fields && ('chat' in fields || 'sender' in fields) ? mapFields(fields, pseudonym) : fields;
  return {
    get level() {
      return log.level;
    },
    trace: (message, fields) => log.trace(message, map(fields)),
    debug: (message, fields) => log.debug(message, map(fields)),
    info: (message, fields) => log.info(message, map(fields)),
    warn: (message, fields) => log.warn(message, map(fields)),
    error: (message, fields) => log.error(message, map(fields)),
    fatal: (message, fields) => log.fatal(message, map(fields)),
    event: (event, fields) => log.event(event, map(fields)),
    child: (bindings) => withPseudonyms(log.child(map(bindings) ?? bindings), pseudonym),
  };
}
