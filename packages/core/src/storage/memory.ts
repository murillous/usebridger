// Adapter em memória do StoragePort: referência executável da semântica do contrato, usado em
// testes e no M1-16. Guarda tudo como texto JSON — como os adapters reais —, então o que entra
// e o que sai são sempre cópias, sem aliasing com objetos do plugin. Cada chamada de
// `createMemoryStorage` tem dados próprios (nenhum estado de módulo).

import { randomUUID } from 'node:crypto';
import { StorageClosedError } from './errors.ts';
import {
  compareStrings,
  fieldValue,
  incrementedValue,
  matches,
  type NormalizedSort,
  normalizeDocument,
  normalizeIncrement,
  normalizeIndexes,
  normalizeQuery,
  normalizeWhere,
} from './query.ts';
import type {
  AuthKeyData,
  AuthStateStore,
  Collection,
  FindQuery,
  IncrementOptions,
  JsonObject,
  JsonValue,
  KeyValueStore,
  Patch,
  PluginStorage,
  StoragePort,
  Target,
  Where,
  WithId,
} from './types.ts';

// id → documento em JSON. A ordem de inserção do Map é a ordem de desempate do contrato, e
// `Map.set` numa chave existente (update) não muda a posição.
type Documents = Map<string, string>;

interface NamespaceData {
  readonly kv: Map<string, string>;
  readonly collections: Map<string, Documents>;
}

interface SessionData {
  creds: string | undefined;
  readonly keys: Map<string, Map<string, string>>;
}

interface Row {
  readonly id: string;
  readonly doc: JsonObject;
}

function serialize(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('Valor não serializável em JSON.');
  return text;
}

function parse<T>(text: string): T {
  return JSON.parse(text) as T;
}

// null/ausente < booleano < número < texto < array/objeto (iguais entre si).
function typeRank(value: JsonValue): number {
  if (value === null) return 0;
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'number') return 2;
  if (typeof value === 'string') return 3;
  return 4;
}

function compareValues(a: JsonValue, b: JsonValue): number {
  const rank = typeRank(a) - typeRank(b);
  if (rank !== 0) return rank;
  if (typeof a === 'boolean') return Number(a) - Number(b);
  if (typeof a === 'number') return a - (b as number);
  if (typeof a === 'string') return compareStrings(a, b as string);
  return 0;
}

function sortRows(rows: Row[], sorts: readonly NormalizedSort[]): Row[] {
  if (sorts.length === 0) return rows;
  // `Array.prototype.sort` é estável: empates mantêm a ordem de inserção.
  return rows.sort((a, b) => {
    for (const { field, direction } of sorts) {
      const diff = compareValues(fieldValue(a, field), fieldValue(b, field));
      if (diff !== 0) return direction === 'asc' ? diff : -diff;
    }
    return 0;
  });
}

/** Cria um StoragePort em memória, com dados próprios e descartados no `close()`. */
export function createMemoryStorage(): StoragePort {
  const namespaces = new Map<string, NamespaceData>();
  const sessions = new Map<string, SessionData>();
  let closed = false;

  function ensureOpen(): void {
    if (closed) throw new StorageClosedError();
  }

  function namespaceData(namespace: string): NamespaceData {
    let data = namespaces.get(namespace);
    if (data === undefined) {
      data = { kv: new Map(), collections: new Map() };
      namespaces.set(namespace, data);
    }
    return data;
  }

  function documents(namespace: string, name: string): Documents {
    const { collections } = namespaceData(namespace);
    let docs = collections.get(name);
    if (docs === undefined) {
      docs = new Map();
      collections.set(name, docs);
    }
    return docs;
  }

  function sessionData(session: string): SessionData {
    let data = sessions.get(session);
    if (data === undefined) {
      data = { creds: undefined, keys: new Map() };
      sessions.set(session, data);
    }
    return data;
  }

  function createKv(namespace: string): KeyValueStore {
    return {
      async get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> {
        ensureOpen();
        const text = namespaceData(namespace).kv.get(key);
        return text === undefined ? undefined : parse<T>(text);
      },
      async set(key: string, value: JsonValue): Promise<void> {
        ensureOpen();
        namespaceData(namespace).kv.set(key, serialize(value));
      },
      async delete(key: string): Promise<boolean> {
        ensureOpen();
        return namespaceData(namespace).kv.delete(key);
      },
    };
  }

  function createCollection<T extends { readonly [key: string]: JsonValue }>(
    namespace: string,
    name: string,
  ): Collection<T> {
    function rows(): Row[] {
      return [...documents(namespace, name)].map(([id, text]) => ({ id, doc: parse(text) }));
    }

    function targetRows(target: Target<T>): Row[] {
      if (typeof target === 'string') {
        const text = documents(namespace, name).get(target);
        return text === undefined ? [] : [{ id: target, doc: parse(text) }];
      }
      const conditions = normalizeWhere(target);
      return rows().filter((row) => matches(row, conditions));
    }

    return {
      async insert(document: T): Promise<string> {
        ensureOpen();
        const text = serialize(normalizeDocument(document));
        const id = randomUUID();
        documents(namespace, name).set(id, text);
        return id;
      },
      async get(id: string): Promise<WithId<T> | undefined> {
        ensureOpen();
        const text = documents(namespace, name).get(id);
        return text === undefined ? undefined : { ...parse<T>(text), id };
      },
      async find(query?: FindQuery<T>): Promise<WithId<T>[]> {
        ensureOpen();
        const { where, orderBy, limit, offset } = normalizeQuery(query);
        const found = sortRows(
          rows().filter((row) => matches(row, where)),
          orderBy,
        );
        const end = limit === undefined ? undefined : offset + limit;
        return found.slice(offset, end).map((row) => ({ ...(row.doc as T), id: row.id }));
      },
      async update(target: Target<T>, patch: Patch<T>): Promise<number> {
        ensureOpen();
        const changes = normalizeDocument(patch);
        const docs = documents(namespace, name);
        const targets = targetRows(target);
        for (const row of targets) docs.set(row.id, serialize({ ...row.doc, ...changes }));
        return targets.length;
      },
      async delete(target: Target<T>): Promise<number> {
        ensureOpen();
        const docs = documents(namespace, name);
        const targets = targetRows(target);
        for (const row of targets) docs.delete(row.id);
        return targets.length;
      },
      async increment(
        where: Where<T>,
        field: keyof T & string,
        by?: number,
        options?: IncrementOptions<T>,
      ): Promise<number> {
        ensureOpen();
        const step = normalizeIncrement(where, field, by, options?.insert);
        const docs = documents(namespace, name);
        // Sem `await` daqui até o fim: o event loop não intercala outra chamada, e é isso que
        // torna a busca + gravação (ou a inserção) atômica no processo.
        const targets = targetRows(where);
        // Valida todos os alvos antes de gravar, para um valor ruim não deixar a soma pela metade.
        const updated = targets.map((row) => ({
          id: row.id,
          text: serialize({ ...row.doc, [field]: incrementedValue(row.doc[field], step.by) }),
        }));
        for (const { id, text } of updated) docs.set(id, text);
        if (updated.length === 0 && step.insert !== undefined) {
          docs.set(randomUUID(), serialize(step.insert));
          return 1;
        }
        return updated.length;
      },
    };
  }

  function createPluginStorage(namespace: string): PluginStorage {
    return {
      kv: createKv(namespace),
      collection<T extends { readonly [key: string]: JsonValue }>(
        name: string,
        options?: Parameters<PluginStorage['collection']>[1],
      ): Collection<T> {
        // Índice não muda o resultado em memória; validar mantém o erro igual ao dos outros
        // adapters, que criam o índice de verdade.
        normalizeIndexes(options);
        return createCollection<T>(namespace, name);
      },
    };
  }

  function createAuthState(session: string): AuthStateStore {
    return {
      async getCreds(): Promise<JsonValue | undefined> {
        ensureOpen();
        const text = sessionData(session).creds;
        return text === undefined ? undefined : parse(text);
      },
      async setCreds(creds: JsonValue): Promise<void> {
        ensureOpen();
        sessionData(session).creds = serialize(creds);
      },
      async getKeys(type: string, ids: readonly string[]): Promise<Record<string, JsonValue>> {
        ensureOpen();
        const stored = sessionData(session).keys.get(type);
        const result: Record<string, JsonValue> = {};
        if (stored === undefined) return result;
        for (const id of ids) {
          const text = stored.get(id);
          if (text !== undefined) result[id] = parse(text);
        }
        return result;
      },
      async setKeys(data: AuthKeyData): Promise<void> {
        ensureOpen();
        // Serializa o lote inteiro antes de aplicar: um valor inválido no meio não deixa o
        // lote pela metade (o equivalente da transação dos adapters SQL).
        const batch = Object.entries(data).map(
          ([type, entries]) =>
            [
              type,
              Object.entries(entries).map(
                ([id, value]) => [id, value === null ? null : serialize(value)] as const,
              ),
            ] as const,
        );
        const { keys } = sessionData(session);
        for (const [type, entries] of batch) {
          let stored = keys.get(type);
          if (stored === undefined) {
            stored = new Map();
            keys.set(type, stored);
          }
          for (const [id, text] of entries) {
            if (text === null) stored.delete(id);
            else stored.set(id, text);
          }
        }
      },
      async clear(): Promise<void> {
        ensureOpen();
        sessions.delete(session);
      },
    };
  }

  return {
    forNamespace(namespace: string): PluginStorage {
      return createPluginStorage(namespace);
    },
    authState(session: string): AuthStateStore {
      return createAuthState(session);
    },
    async close(): Promise<void> {
      closed = true;
      namespaces.clear();
      sessions.clear();
    },
  };
}
