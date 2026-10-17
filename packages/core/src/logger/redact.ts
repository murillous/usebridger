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
 * Devolve uma cópia profunda de `value` com os segredos trocados em toda string, sem nunca devolver
 * a referência de um objeto original. `Error` e objeto simples mantêm o protótipo (`instanceof`
 * vale; `Error.isError(copia)` dá `false`, pois a cópia não é um Error nativo); `Map`, `Set` e
 * arrays são recriados; instância de outra classe (ex.: `AxiosHeaders` num `cause`) vira objeto
 * simples com as propriedades próprias enumeráveis. Propriedades são lidas com `Reflect.get` e
 * gravadas como dado: getters (o `stack` do Error é accessor no Node 24) viram valor censurado, e
 * um getter que lança vira `undefined`. Chaves `Symbol` são descartadas. Buffers viram um texto
 * com o tamanho. Não usa o `clean` do `signal.ts`: ele achata o `Error` em objeto simples e a
 * classe (`PluginHostStateError`...) é o que o consumidor testa.
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
    if (value instanceof Date) return new Date(value.getTime());
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      return `[Buffer ${value.byteLength} bytes]`;
    }
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      done.set(value, copy);
      for (const item of value) copy.push(walk(item, done));
      return copy;
    }
    if (value instanceof Map) {
      const copy = new Map<unknown, unknown>();
      done.set(value, copy);
      for (const [key, item] of value) copy.set(walk(key, done), walk(item, done));
      return copy;
    }
    if (value instanceof Set) {
      const copy = new Set<unknown>();
      done.set(value, copy);
      for (const item of value) copy.add(walk(item, done));
      return copy;
    }
    const keepProto = value instanceof Error || isPlain(value);
    const copy = (keepProto ? Object.create(Object.getPrototypeOf(value)) : {}) as Record<
      string,
      unknown
    >;
    done.set(value, copy);
    // `message` e `stack` do Error são próprios e não enumeráveis: só o Error os inclui todos.
    const keys = value instanceof Error ? Object.getOwnPropertyNames(value) : Object.keys(value);
    for (const key of keys) {
      let item: unknown;
      try {
        item = Reflect.get(value, key);
      } catch {
        item = undefined;
      }
      Object.defineProperty(copy, key, {
        value: walk(item, done),
        enumerable: Object.getOwnPropertyDescriptor(value, key)?.enumerable ?? true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  };

  return <T>(value: T): T => walk(value, new WeakMap()) as T;
}
