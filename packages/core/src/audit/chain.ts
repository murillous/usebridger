// Hash encadeado do log de auditoria (ADR 0122): HMAC-SHA256 sobre `prevHash` + JSON canônico.

import { createHmac, randomBytes } from 'node:crypto';

export const GENESIS_HASH: string = '0'.repeat(64);

/** JSON canônico: chaves ordenadas, sem espaços, `undefined` omitido. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  const body = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
  return `{${body.join(',')}}`;
}

/** `event` é o evento sem o campo `hash`. */
export function chainHash(key: Buffer, prevHash: string, event: object): string {
  return createHmac('sha256', key).update(prevHash).update(canonical(event)).digest('hex');
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Ulid (26 caracteres Crockford): 48 bits de tempo e 80 de aleatório. */
export function ulid(timeMs: number): string {
  let time = '';
  for (let rest = timeMs, i = 0; i < 10; i++, rest = Math.floor(rest / 32)) {
    time = CROCKFORD[rest % 32] + time;
  }
  let random = '';
  for (const byte of randomBytes(16)) random += CROCKFORD[byte % 32];
  return time + random;
}
