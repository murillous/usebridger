// Validação e forma canônica de consultas e documentos. Todo adapter passa a entrada do plugin
// por aqui antes de traduzir para o engine: os erros (TypeError/RangeError) saem iguais em
// memória, SQLite e Postgres, e o adapter só lida com uma lista plana de condições já
// validadas — nomes de campo seguros para montar caminho JSON, operandos com tipo conhecido.

import type {
  CollectionOptions,
  FindQuery,
  JsonObject,
  JsonValue,
  Scalar,
  SortDirection,
  Where,
} from './types.ts';

/** Documento com o `id` que o adapter lhe deu; é o que `matches` e `fieldValue` leem. */
export interface Row {
  readonly id: string;
  readonly doc: JsonObject;
}

export type FilterOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';

/** Uma condição validada; as condições de uma consulta combinam com E. */
export type NormalizedCondition =
  | { readonly field: string; readonly op: 'eq' | 'ne'; readonly value: Scalar }
  | {
      readonly field: string;
      readonly op: 'gt' | 'gte' | 'lt' | 'lte';
      readonly value: string | number;
    }
  | { readonly field: string; readonly op: 'in'; readonly value: readonly Scalar[] };

export interface NormalizedSort {
  readonly field: string;
  readonly direction: SortDirection;
}

export interface NormalizedQuery {
  readonly where: readonly NormalizedCondition[];
  readonly orderBy: readonly NormalizedSort[];
  /** `undefined` = sem limite. */
  readonly limit: number | undefined;
  readonly offset: number;
}

const OPERATORS: ReadonlySet<string> = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']);
// Identificador simples: dá para interpolar em caminho JSON (`$.campo`, `doc->>'campo'`) sem
// escape, e campos aninhados ficam fora do contrato (precisariam de semântica própria).
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Lança `TypeError` se `field` não serve como campo de filtro, ordenação ou índice. */
export function assertFieldName(field: string): void {
  if (!FIELD_NAME.test(field)) {
    throw new TypeError(
      `Campo inválido "${field}": use um campo de primeiro nível no formato [A-Za-z_][A-Za-z0-9_]*.`,
    );
  }
}

function isScalar(value: unknown): value is Scalar {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  return typeof value === 'number' && Number.isFinite(value);
}

function assertScalar(field: string, op: string, value: unknown): asserts value is Scalar {
  if (!isScalar(value)) {
    throw new TypeError(
      `Operando de "${op}" em "${field}" deve ser texto, número finito, booleano ou null.`,
    );
  }
}

function assertOrdered(
  field: string,
  op: string,
  value: unknown,
): asserts value is string | number {
  const ok = typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
  if (!ok)
    throw new TypeError(`Operando de "${op}" em "${field}" deve ser texto ou número finito.`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Converte um filtro na lista canônica de condições. `undefined`/`{}` = sem condições. */
export function normalizeWhere<T>(where: Where<T> | undefined): readonly NormalizedCondition[] {
  if (where === undefined) return [];
  if (!isPlainObject(where)) throw new TypeError('`where` deve ser um objeto.');
  const conditions: NormalizedCondition[] = [];
  for (const [field, condition] of Object.entries(where)) {
    // `{ campo: undefined }` some, como no JSON: permite montar filtros com campos opcionais.
    if (condition === undefined) continue;
    assertFieldName(field);
    if (!isPlainObject(condition)) {
      assertScalar(field, 'eq', condition);
      conditions.push({ field, op: 'eq', value: condition });
      continue;
    }
    const entries = Object.entries(condition).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      throw new TypeError(`Filtro de "${field}" sem operadores; use um valor ou { eq, ne, ... }.`);
    }
    for (const [op, value] of entries) {
      if (!OPERATORS.has(op)) throw new TypeError(`Operador desconhecido "${op}" em "${field}".`);
      if (op === 'eq' || op === 'ne') {
        assertScalar(field, op, value);
        conditions.push({ field, op, value });
      } else if (op === 'in') {
        if (!Array.isArray(value))
          throw new TypeError(`Operando de "in" em "${field}" deve ser array.`);
        for (const item of value) assertScalar(field, op, item);
        conditions.push({ field, op, value: [...(value as Scalar[])] });
      } else {
        assertOrdered(field, op, value);
        conditions.push({ field, op: op as 'gt' | 'gte' | 'lt' | 'lte', value });
      }
    }
  }
  return conditions;
}

function normalizeSort(sort: unknown): NormalizedSort {
  if (typeof sort === 'string') {
    assertFieldName(sort);
    return { field: sort, direction: 'asc' };
  }
  if (!isPlainObject(sort) || typeof sort['field'] !== 'string') {
    throw new TypeError('Critério de `orderBy` deve ser um campo ou { field, direction }.');
  }
  assertFieldName(sort['field']);
  const direction = sort['direction'] ?? 'asc';
  if (direction !== 'asc' && direction !== 'desc') {
    throw new TypeError(`Direção inválida "${String(direction)}": use 'asc' ou 'desc'.`);
  }
  return { field: sort['field'], direction };
}

function normalizeCount(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RangeError(`\`${name}\` deve ser inteiro >= 0 (recebido: ${String(value)}).`);
  }
  return value;
}

/** Valida a consulta e devolve a forma canônica que o adapter traduz para o engine. */
export function normalizeQuery<T>(query: FindQuery<T> | undefined): NormalizedQuery {
  if (query === undefined) return { where: [], orderBy: [], limit: undefined, offset: 0 };
  if (!isPlainObject(query as unknown)) throw new TypeError('A consulta deve ser um objeto.');
  const { where, orderBy, limit, offset } = query;
  const sorts: readonly unknown[] =
    orderBy === undefined ? [] : Array.isArray(orderBy) ? orderBy : [orderBy];
  return {
    where: normalizeWhere(where),
    orderBy: sorts.map(normalizeSort),
    limit: normalizeCount('limit', limit),
    offset: normalizeCount('offset', offset) ?? 0,
  };
}

/** Campos de índice validados e sem repetição. */
export function normalizeIndexes(options: CollectionOptions | undefined): readonly string[] {
  const indexes = options?.indexes ?? [];
  for (const field of indexes) assertFieldName(field);
  return [...new Set(indexes)];
}

/**
 * Cópia JSON de um documento (ou patch) a gravar: exige objeto, recusa o campo reservado `id`
 * e aplica a semântica de `JSON.stringify` (campos `undefined` somem, `NaN`/`Infinity` viram
 * `null`). O adapter grava exatamente o que sai daqui.
 */
export function normalizeDocument(document: unknown): JsonObject {
  if (!isPlainObject(document)) throw new TypeError('Documento deve ser um objeto JSON.');
  const copy = JSON.parse(JSON.stringify(document)) as JsonObject;
  if (Object.hasOwn(copy, 'id')) {
    throw new TypeError('O campo "id" é reservado: o adapter gera o id do documento.');
  }
  return copy;
}

/**
 * Valor do campo depois de somar `by`: ausente/`null` vale 0 e o que não é número lança
 * `TypeError`, assim como a soma que estoura para Infinity (o JSON a gravaria como `null` e
 * zeraria o contador). Os adapters usam o mesmo cálculo para o documento alvo e para o `insert`.
 */
export function incrementedValue(current: unknown, by: number): number {
  if (current !== undefined && current !== null && typeof current !== 'number') {
    throw new TypeError('increment exige que o campo seja numérico nos documentos alvo.');
  }
  const result = (current ?? 0) + by;
  if (!Number.isFinite(result)) {
    throw new TypeError('increment estourou o limite de número do JSON.');
  }
  return result;
}

export interface NormalizedIncrement {
  readonly field: string;
  readonly by: number;
  /** Documento do `insert` já com `field` somado; `undefined` se não houve `insert`. */
  readonly insert: JsonObject | undefined;
}

/**
 * Valida os argumentos de `increment` antes de qualquer leitura ou gravação. O `insert` precisa
 * casar com o `where` (já com o campo somado): senão a próxima chamada não o acharia e inseriria
 * outro, o duplicado que o `insert` existe para evitar; nesse caso lança `TypeError`.
 */
export function normalizeIncrement<T>(
  where: Where<T> | undefined,
  field: string,
  by: number | undefined,
  insert: unknown,
): NormalizedIncrement {
  const conditions = normalizeWhere(where);
  assertFieldName(field);
  if (field === 'id') throw new TypeError('O campo "id" é reservado e não pode ser incrementado.');
  const step = by ?? 1;
  if (typeof step !== 'number' || !Number.isFinite(step)) {
    throw new TypeError('increment exige "by" como número finito.');
  }
  if (insert === undefined) return { field, by: step, insert: undefined };
  const doc = normalizeDocument(insert);
  const inserted = { ...doc, [field]: incrementedValue(doc[field], step) };
  // O documento ainda não tem id; '' só serve para a condição não achar `id` no lugar errado.
  if (!matches({ id: '', doc: inserted }, conditions)) {
    throw new TypeError('increment exige que o "insert" case com o "where".');
  }
  return { field, by: step, insert: inserted };
}

// Casamento em memória: a referência de semântica que os adapters SQL reproduzem.
export function fieldValue(row: Row, field: string): JsonValue {
  if (field === 'id') return row.id;
  // Campo ausente vale null, igual ao `json_extract`/`->>` dos adapters SQL.
  return Object.hasOwn(row.doc, field) ? (row.doc[field] as JsonValue) : null;
}

// Igualdade estrita de tipo e valor: o adapter SQLite precisa conferir `json_type`, porque
// `json_extract` devolve `true` como 1.
function equals(value: JsonValue, operand: Scalar): boolean {
  if (operand === null) return value === null;
  return typeof value === typeof operand && value === operand;
}

// Ordem de code point (= ordem de bytes UTF-8, a do SQLite BINARY e do Postgres COLLATE "C").
// O `<` do JS compara unidades UTF-16 e erra quando um lado é surrogate.
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) {
      return (a.codePointAt(i) as number) - (b.codePointAt(i) as number);
    }
  }
  return a.length - b.length;
}

function compareOrdered(value: JsonValue, operand: string | number): number | undefined {
  if (typeof value === 'number' && typeof operand === 'number') return value - operand;
  if (typeof value === 'string' && typeof operand === 'string') {
    return compareStrings(value, operand);
  }
  return undefined;
}

export function matches(row: Row, conditions: readonly NormalizedCondition[]): boolean {
  return conditions.every((condition) => {
    const value = fieldValue(row, condition.field);
    switch (condition.op) {
      case 'eq':
        return equals(value, condition.value);
      case 'ne':
        return !equals(value, condition.value);
      case 'in':
        return condition.value.some((operand) => equals(value, operand));
      default: {
        const diff = compareOrdered(value, condition.value);
        if (diff === undefined) return false;
        if (condition.op === 'gt') return diff > 0;
        if (condition.op === 'gte') return diff >= 0;
        if (condition.op === 'lt') return diff < 0;
        return diff <= 0;
      }
    }
  });
}

/** Cópia JSON de um valor de KV ou auth state, com a mesma semântica de `JSON.stringify`. */
export function cloneJson<T extends JsonValue>(value: T): T {
  const text = JSON.stringify(value);
  // `JSON.stringify(undefined)` devolve undefined: só acontece fora dos tipos, mas o erro
  // precisa ser claro em vez de um SyntaxError do parse.
  if (text === undefined) throw new TypeError('Valor não serializável em JSON.');
  return JSON.parse(text) as T;
}
