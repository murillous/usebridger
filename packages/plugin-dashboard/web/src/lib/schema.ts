import type { ConfigIssue } from './types.ts';

type Json = Record<string, unknown>;
export type FlatValues = Record<string, unknown>;

export type Control = 'text' | 'number' | 'integer' | 'boolean' | 'enum' | 'list' | 'json';

export interface Field {
  /** Caminho com pontos (`openai.model`), o mesmo `path` das issues do servidor. */
  path: string;
  label: string;
  description?: string;
  control: Control;
  required: boolean;
  /** Campo `secret`: só máscara, nunca entra no PUT. */
  secret: boolean;
  options?: string[];
  /** Tipo dos itens de `list`. */
  item?: 'text' | 'number';
  default?: unknown;
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
      return { control: 'text' };
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
    default:
      return { control: 'json' };
  }
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
    const label = typeof prop['title'] === 'string' ? prop['title'] : key;
    const description = typeof prop['description'] === 'string' ? prop['description'] : undefined;
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
      secret: prop['secret'] === true,
      default: prop['default'],
      ...control(prop),
    });
  }
  return nodes;
}

export function leaves(nodes: Node[]): Field[] {
  return nodes.flatMap((n) => (n.node === 'group' ? leaves(n.fields) : [n]));
}

/** `{a:{b:1}}` -> `{'a.b':1}`. Só desce em objetos simples; array e valor ficam folhas. */
export function flatten(value: unknown, prefix = ''): FlatValues {
  if (!isObject(value)) return prefix ? { [prefix]: value } : {};
  const out: FlatValues = {};
  for (const [key, child] of Object.entries(value)) {
    Object.assign(out, flatten(child, prefix ? `${prefix}.${key}` : key));
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
): Json {
  const flat: FlatValues = {};
  for (const field of fields) {
    if (field.secret) continue;
    const value = current[field.path];
    const dirty = !sameValue(value, initial[field.path]);
    if (value === undefined) continue;
    if (dirty || sources[field.path] === 'override') flat[field.path] = value;
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
