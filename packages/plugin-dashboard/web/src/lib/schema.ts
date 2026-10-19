import type { ConfigIssue } from './types.ts';

type Json = Record<string, unknown>;
export type FlatValues = Record<string, unknown>;

export type Control =
  | 'text'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'datetime'
  | 'list'
  | 'record'
  | 'json';

export interface Field {
  /** Caminho com pontos (`openai.model`), o mesmo `path` das issues do servidor. */
  path: string;
  label: string;
  description?: string;
  control: Control;
  required: boolean;
  /** Campo `secret`: só máscara, nunca entra no PUT. */
  secret: boolean;
  /** `x-bridger-set-secret` (ADR 0117): o core aceita `setSecret` neste campo (há chave mestra). */
  settable: boolean;
  options?: string[];
  /** Exemplo do schema (`examples[0]`), usado como placeholder. */
  placeholder?: string;
  /** Tipo dos itens de `list` e dos valores de `record`. */
  item?: 'text' | 'number';
  default?: unknown;
  /** Tipo Zod aproximado a partir do JSON Schema (`z.number().min(0)`), para a dica do campo. */
  hint: string;
  /** Limites do schema (`minimum`/`minLength`, `maximum`/`maxLength`), para a validação local. */
  min?: number;
  max?: number;
}

export interface Group {
  path: string;
  label: string;
  description?: string;
  fields: Node[];
}

export type Node = ({ node: 'field' } & Field) | ({ node: 'group' } & Group);

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `type` pode vir como `['string','null']`: vale o primeiro que não é null. */
function typeOf(schema: Json): string | undefined {
  const { type } = schema;
  if (Array.isArray(type)) return type.find((t) => t !== 'null') as string | undefined;
  return typeof type === 'string' ? type : undefined;
}

/** `anyOf: [X, {type:'null'}]` (optional/nullable do Zod) vira X; o resto fica como está. */
function unwrap(schema: Json): Json {
  const variants = schema['anyOf'] ?? schema['oneOf'];
  if (!Array.isArray(variants)) return schema;
  const real = variants.filter((v) => isObject(v) && typeOf(v) !== 'null') as Json[];
  const [only] = real;
  return real.length === 1 && only
    ? { ...only, ...schema, anyOf: undefined, oneOf: undefined }
    : schema;
}

function control(schema: Json): Pick<Field, 'control' | 'options' | 'item'> {
  const options = schema['enum'];
  if (Array.isArray(options)) return { control: 'enum', options: options.map(String) };
  if (schema['const'] !== undefined) return { control: 'enum', options: [String(schema['const'])] };
  switch (typeOf(schema)) {
    case 'string':
      return { control: schema['format'] === 'date-time' ? 'datetime' : 'text' };
    case 'number':
      return { control: 'number' };
    case 'integer':
      return { control: 'integer' };
    case 'boolean':
      return { control: 'boolean' };
    case 'array': {
      const items = isObject(schema['items']) ? typeOf(unwrap(schema['items'])) : undefined;
      if (items === 'string') return { control: 'list', item: 'text' };
      if (items === 'number' || items === 'integer') return { control: 'list', item: 'number' };
      return { control: 'json' };
    }
    case 'object': {
      const values = schema['additionalProperties'];
      const kind = isObject(values) ? typeOf(unwrap(values)) : undefined;
      if (kind === 'string') return { control: 'record', item: 'text' };
      if (kind === 'number' || kind === 'integer') return { control: 'record', item: 'number' };
      return { control: 'json' };
    }
    default:
      return { control: 'json' };
  }
}

const ZOD: Record<string, string> = {
  string: 'z.string()',
  number: 'z.number()',
  integer: 'z.int()',
  boolean: 'z.boolean()',
  array: 'z.array()',
  object: 'z.record()',
};

/** `z.int()` vira `±MAX_SAFE_INTEGER` no JSON Schema: limite que ninguém escreveu não conta. */
export function boundsOf(schema: Json): { min?: number; max?: number } {
  const [lo, hi] =
    typeOf(schema) === 'string' ? ['minLength', 'maxLength'] : ['minimum', 'maximum'];
  const pick = (key: string | undefined): number | undefined => {
    const v = key === undefined ? undefined : schema[key];
    return typeof v === 'number' && Math.abs(v) < Number.MAX_SAFE_INTEGER ? v : undefined;
  };
  return { min: pick(lo), max: pick(hi) };
}

/** Só o que o JSON Schema deixa ver: tipo e limites. Não tenta reconstruir refinamentos. */
export function hintOf(schema: Json): string {
  if (Array.isArray(schema['enum']) || schema['const'] !== undefined) return 'z.enum';
  let hint = ZOD[typeOf(schema) ?? ''] ?? 'z.json()';
  const { min, max } = boundsOf(schema);
  if (min !== undefined) hint += `.min(${min})`;
  if (max !== undefined) hint += `.max(${max})`;
  return hint;
}

/** Gera os campos do formulário a partir do JSON Schema (objeto) da config do plugin. */
export function buildFields(schema: Json | null, prefix = ''): Node[] {
  if (!schema) return [];
  const properties = isObject(schema['properties']) ? schema['properties'] : {};
  const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  const nodes: Node[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    if (!isObject(raw)) continue;
    const prop = unwrap(raw);
    const path = prefix ? `${prefix}.${key}` : key;
    const title = typeof prop['title'] === 'string' ? prop['title'] : undefined;
    const text = typeof prop['description'] === 'string' ? prop['description'] : undefined;
    // title > description > nome da propriedade (com inicial maiúscula); a descrição que virou rótulo não repete na ajuda.
    const label = title ?? text ?? key.charAt(0).toUpperCase() + key.slice(1);
    const description = title === undefined && text !== undefined ? undefined : text;
    const [example] = Array.isArray(prop['examples']) ? prop['examples'] : [];
    const placeholder =
      typeof example === 'string' || typeof example === 'number' ? String(example) : undefined;
    if (typeOf(prop) === 'object' && isObject(prop['properties'])) {
      nodes.push({ node: 'group', path, label, description, fields: buildFields(prop, path) });
      continue;
    }
    nodes.push({
      node: 'field',
      path,
      label,
      description,
      required: required.includes(key),
      // `x-bridger-override: false` também marca secreto: o core o põe sempre, sem depender de `secret`.
      secret: prop['secret'] === true || prop['x-bridger-override'] === false,
      settable: prop['x-bridger-set-secret'] === true,
      placeholder,
      default: prop['default'],
      hint: hintOf(prop),
      ...boundsOf(prop),
      ...control(prop),
    });
  }
  return nodes;
}

export function leaves(nodes: Node[]): Field[] {
  return nodes.flatMap((n) => (n.node === 'group' ? leaves(n.fields) : [n]));
}

/**
 * `{a:{b:1}}` -> `{'a.b':1}`. Só desce em objetos simples; array e valor ficam folhas, e `stop`
 * lista os caminhos que são campos do form (um `z.record` é uma folha `record`, não várias chaves).
 */
export function flatten(value: unknown, prefix = '', stop?: ReadonlySet<string>): FlatValues {
  if (!isObject(value) || (prefix !== '' && stop?.has(prefix))) {
    return prefix ? { [prefix]: value } : {};
  }
  const out: FlatValues = {};
  for (const [key, child] of Object.entries(value)) {
    Object.assign(out, flatten(child, prefix ? `${prefix}.${key}` : key, stop));
  }
  return out;
}

/** Inverso de `flatten`: `{'a.b':1}` -> `{a:{b:1}}`. */
export function unflatten(flat: FlatValues): Json {
  const out: Json = {};
  for (const [path, value] of Object.entries(flat)) {
    const keys = path.split('.');
    let cursor = out;
    for (const key of keys.slice(0, -1)) {
      const next = cursor[key];
      if (isObject(next)) cursor = next;
      else {
        const created: Json = {};
        cursor[key] = created;
        cursor = created;
      }
    }
    cursor[keys[keys.length - 1] as string] = value;
  }
  return out;
}

/**
 * Overrides a enviar. O PUT substitui todos os overrides do plugin, então ficam os que já
 * eram `override` (fonte) mais os que o usuário mexeu; o que vem de default, arquivo ou env
 * não vira override sem querer. Secret nunca entra (o servidor recusa).
 */
export function buildOverrides(
  fields: Field[],
  initial: FlatValues,
  current: FlatValues,
  sources: Record<string, string>,
  /** Valores fora do form (`messages.<k>` de `view.messages`): repassados se eram override. */
  extra: FlatValues = {},
): Json {
  const flat: FlatValues = {};
  const overridden = Object.keys(sources).filter((path) => sources[path] === 'override');
  const known = new Set<string>();
  for (const field of fields) {
    known.add(field.path);
    if (field.secret) continue;
    const value = current[field.path];
    const dirty = !sameValue(value, initial[field.path]);
    if (value === undefined) continue;
    // Record: o servidor lista as chaves (`extra.a`) como fonte, não o campo em si.
    const wasOverride = overridden.some((p) => p === field.path || p.startsWith(`${field.path}.`));
    if (dirty || wasOverride) flat[field.path] = value;
  }
  // O PUT substitui todos os overrides: o que o form não edita (messages) precisa ir junto.
  for (const path of overridden) {
    if (known.has(path) || [...known].some((k) => path.startsWith(`${k}.`))) continue;
    if (extra[path] !== undefined) flat[path] = extra[path];
  }
  return unflatten(flat);
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const isDirty = (initial: FlatValues, current: FlatValues): boolean => {
  const keys = new Set([...Object.keys(initial), ...Object.keys(current)]);
  for (const key of keys) if (!sameValue(initial[key], current[key])) return true;
  return false;
};

/** Texto do campo numérico -> número; vazio = ausente; texto inválido segue cru para o servidor recusar. */
export function parseNumber(text: string): number | string | undefined {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isNaN(n) ? text : n;
}

/** ISO (`2026-01-02T03:04:05Z`) -> valor do `datetime-local` no fuso local; ausente ou inválido vira vazio. */
export function isoToLocal(value: unknown): string {
  const date = typeof value === 'string' ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Valor do `datetime-local` (fuso local) -> ISO em UTC; vazio ou inválido vira ausente. */
export function localToIso(text: string): string | undefined {
  const date = new Date(text);
  return text === '' || Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Uma linha por item; `number` converte cada linha. */
export function parseList(text: string, item: 'text' | 'number'): unknown[] {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return item === 'number' ? lines.map((line) => parseNumber(line)) : lines;
}

/** Issues do servidor por campo; as que não casam com nenhum campo vão em `orphans`. */
export function groupIssues(
  issues: ConfigIssue[],
  fields: Field[],
): { byPath: Record<string, string[]>; orphans: ConfigIssue[] } {
  const known = new Set(fields.map((f) => f.path));
  const byPath: Record<string, string[]> = {};
  const orphans: ConfigIssue[] = [];
  for (const issue of issues) {
    if (known.has(issue.path)) byPath[issue.path] = [...(byPath[issue.path] ?? []), issue.message];
    else orphans.push(issue);
  }
  return { byPath, orphans };
}

/** Itens da lista -> linhas de texto do editor (uma por item). */
export const listToRows = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : [];

/** Linhas do editor -> lista; linha em branco some, como no `parseList`; vazia vira ausente, como o record. */
export function rowsToList(rows: string[], item: 'text' | 'number'): unknown[] | undefined {
  const list = parseList(rows.join('\n'), item);
  return list.length > 0 ? list : undefined;
}

/** Record -> pares `[chave, valor]` em texto. */
export const recordToRows = (value: unknown): [string, string][] =>
  isObject(value) ? Object.entries(value).map(([k, v]) => [k, String(v)]) : [];

/**
 * Pares -> record; par sem chave some, vazio vira ausente. shortcut: chave repetida fica com a
 * última, sem aviso; avisar se a tela passar a aceitar records grandes.
 */
export function rowsToRecord(rows: [string, string][], kind: 'text' | 'number'): Json | undefined {
  const entries = rows
    .filter(([key]) => key.trim() !== '')
    .map(([key, value]) => [key, kind === 'number' ? parseNumber(value) : value] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Espelha `toEnvSegment` do core (`apiKey` -> `API_KEY`): o web não importa o core. */
const envSegment = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toUpperCase();

/** Variável de ambiente de um campo: `BRIDGER_<PLUGIN>__<CAMPO>[__<SUBCAMPO>]` (`envName` do core). */
export const envName = (plugin: string, path: string): string =>
  [`BRIDGER_${envSegment(plugin)}`, ...path.split('.').map(envSegment)].join('__');

/** Plugins que recarregam junto com `name` no reload em cascata: dependentes diretos e indiretos. */
export function dependentsOf(
  rows: {
    name: string;
    dependsOn?: Record<string, string>;
    optionalDependsOn?: Record<string, string>;
  }[],
  name: string,
): string[] {
  const out = new Set<string>();
  const queue = [name];
  for (let cur = queue.shift(); cur !== undefined; cur = queue.shift()) {
    for (const row of rows) {
      const depends = cur in (row.dependsOn ?? {}) || cur in (row.optionalDependsOn ?? {});
      if (depends && !out.has(row.name) && row.name !== name) {
        out.add(row.name);
        queue.push(row.name);
      }
    }
  }
  return [...out];
}

/** Plugin do hash `config/<plugin>`; vazio ou `%` malformado não derruba o app (volta a `undefined`). */
export function configPluginOf(route: string): string | undefined {
  if (!route.startsWith('config/')) return undefined;
  try {
    return decodeURIComponent(route.slice('config/'.length)) || undefined;
  } catch {
    return undefined;
  }
}
