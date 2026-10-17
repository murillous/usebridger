// Máscara de segredos para dados que saem do core por fora do logger (`ctx.admin`, ADR 0111): o
// log já censura, mas uma mensagem de erro devolvida a um cliente (dashboard) sairia crua.

import { MIN_SECRET_LENGTH } from './logger.ts';
import type { SecretSource } from './secrets.ts';

const CENSOR = '[REDACTED]';

const isPlain = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Devolve uma cópia profunda de `value` com os segredos trocados em toda string. `Error` mantém a
 * classe (`instanceof` e campos próprios, como `issues` e `cause`) com `message`/`stack`
 * censurados. O original não é tocado. Valores que não são texto, objeto simples, array nem
 * `Error` passam como estão.
 */
export function createRedactor(secrets: SecretSource): <T>(value: T) => T {
  let seen = -1;
  let needles: string[] = [];
  const censor = (text: string): string => {
    if (secrets.version !== seen) {
      seen = secrets.version;
      needles = secrets
        .values()
        .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
        .sort((a, b) => b.length - a.length);
    }
    let out = text;
    for (const needle of needles) out = out.replaceAll(needle, CENSOR);
    return out;
  };

  const walk = (value: unknown, done: WeakMap<object, unknown>): unknown => {
    if (typeof value === 'string') return censor(value);
    if (typeof value !== 'object' || value === null) return value;
    if (done.has(value)) return done.get(value);
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      done.set(value, copy);
      for (const item of value) copy.push(walk(item, done));
      return copy;
    }
    if (!(value instanceof Error) && !isPlain(value)) return value;
    const copy = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
    done.set(value, copy);
    // `message` e `stack` do Error são próprios e não enumeráveis: `getOwnPropertyNames` os pega.
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor;
      Object.defineProperty(copy, key, {
        ...descriptor,
        ...('value' in descriptor && { value: walk(descriptor.value, done) }),
      });
    }
    return copy;
  };

  return <T>(value: T): T => walk(value, new WeakMap()) as T;
}
