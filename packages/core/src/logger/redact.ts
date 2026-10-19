// Máscara de segredos para dados que saem do core por fora do logger (`ctx.admin`, ADR 0107): o
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
    // Caixa (`new String('sk-…')`) não tem chaves úteis: vale o primitivo.
    if (value instanceof String || value instanceof Number || value instanceof Boolean) {
      return walk(value.valueOf(), done);
    }
    const keepProto = value instanceof Error || isPlain(value);
    const copy = (keepProto ? Object.create(Object.getPrototypeOf(value)) : {}) as Record<
      string,
      unknown
    >;
    done.set(value, copy);
    const put = (key: string, item: unknown, enumerable: boolean): void => {
      Object.defineProperty(copy, key, {
        value: walk(item, done),
        enumerable,
        writable: true,
        configurable: true,
      });
    };
    // Proxy que lança em `ownKeys` não pode trocar o erro original pelo do redactor.
    let keys: string[];
    try {
      // `message` e `stack` do Error são próprios e não enumeráveis: só o Error os inclui todos.
      keys = value instanceof Error ? Object.getOwnPropertyNames(value) : Object.keys(value);
    } catch {
      return '[unreadable]';
    }
    for (const key of keys) {
      let item: unknown;
      try {
        item = Reflect.get(value, key);
      } catch {
        item = undefined;
      }
      put(key, item, Object.getOwnPropertyDescriptor(value, key)?.enumerable ?? true);
    }
    // A cópia mantém o protótipo do Error: getters e `toJSON` dele rodariam sobre a cópia (e
    // lançariam em `#privado`, ou devolveriam dado cru). Viram campos de dado já censurados.
    if (value instanceof Error) {
      for (
        let proto = Object.getPrototypeOf(value) as object | null;
        proto !== null && proto !== Error.prototype && proto !== Object.prototype;
        proto = Object.getPrototypeOf(proto)
      ) {
        for (const key of Object.getOwnPropertyNames(proto)) {
          if (key === 'constructor' || Object.hasOwn(copy, key)) continue;
          const descriptor = Object.getOwnPropertyDescriptor(proto, key);
          if (descriptor?.get !== undefined) {
            let item: unknown;
            try {
              item = Reflect.get(proto, key, value);
            } catch {
              item = undefined;
            }
            put(key, item, false);
          } else if (key === 'toJSON' && typeof descriptor?.value === 'function') {
            let json: unknown;
            let ok = true;
            try {
              json = walk(descriptor.value.call(value), done);
            } catch {
              ok = false; // toJSON que lança: omitido, a cópia serializa pelos campos.
            }
            if (ok) Object.defineProperty(copy, key, { value: () => json, configurable: true });
          }
        }
      }
    }
    return copy;
  };

  return <T>(value: T): T => walk(value, new WeakMap()) as T;
}
