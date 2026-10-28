// Formulário de config de plugin sobre `GET/PUT /plugins/{name}/config` (ADR 0131). O `PUT`
// substitui todos os overrides, então o corpo leva os que já existiam mais o que a pessoa mudou.

import type { JsonSchema } from './spec.ts';

/** Máscara dos segredos na `view` (`SECRET_MASK` do core): devolvida, mantém o valor salvo. */
export const MASK = '********';

export interface ConfigView {
  config: unknown;
  messages: Record<string, string>;
  sources: Record<string, string>;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Folhas de um objeto por caminho pontilhado; array é folha (o override troca a lista inteira). */
export function flatten(value: unknown, prefix = '', out: Json = {}): Json {
  if (!isObject(value)) {
    if (prefix !== '') out[prefix] = value;
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix === '' ? key : `${prefix}.${key}`, out);
  }
  return out;
}

export function unflatten(flat: Json): Json {
  const out: Json = {};
  for (const [path, value] of Object.entries(flat)) {
    const keys = path.split('.');
    let node = out;
    for (const key of keys.slice(0, -1)) {
      if (!isObject(node[key])) node[key] = {};
      node = node[key] as Json;
    }
    node[keys[keys.length - 1] as string] = value;
  }
  return out;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Corpo do `PUT`: os overrides que já existiam (fonte `override`, inclusive `messages.*`, que não
 * são campos do form) mais o que mudou. Segredo com a máscara fica de fora, e o core mantém o salvo;
 * campo esvaziado sai, e volta o default.
 */
export function buildOverrides(view: ConfigView, edited: unknown): Json {
  const initial = flatten(view.config);
  const current = flatten(edited);
  const overridden = Object.keys(view.sources).filter((p) => view.sources[p] === 'override');
  const wasOverride = (path: string) =>
    overridden.some((p) => p === path || p.startsWith(`${path}.`));
  const out: Json = {};
  for (const [path, value] of Object.entries(current)) {
    if (value === undefined || value === MASK) continue;
    if (!same(value, initial[path]) || wasOverride(path)) out[path] = value;
  }
  for (const path of overridden) {
    if (!path.startsWith('messages.')) continue;
    const message = view.messages[path.slice('messages.'.length)];
    if (message !== undefined) out[path] = message;
  }
  return unflatten(out);
}

/**
 * Schema para o form: o segredo perde as regras de formato (a máscara não passaria num `minLength`
 * nem num `pattern`); o core valida o valor novo de qualquer forma.
 */
export function formSchema(schema: JsonSchema): JsonSchema {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObject(node)) return node;
    if (node['secret'] === true) {
      const { minLength, maxLength, pattern, format, ...rest } = node;
      return rest;
    }
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value)]));
  };
  return walk(schema) as JsonSchema;
}

const ORIGIN: Record<string, string> = {
  env: 'Definido no ambiente: o valor do painel não tem efeito.',
  file: 'Definido no arquivo de config: o valor do painel não tem efeito.',
};

/**
 * `uiSchema` do rjsf: segredo vira campo de senha, e o que o env ou o arquivo decidem fica só
 * leitura, com a origem como ajuda.
 */
export function configUi(schema: JsonSchema, sources: Record<string, string>): Json {
  const walk = (node: unknown, path: string): Json => {
    const ui: Json = {};
    if (!isObject(node)) return ui;
    if (node['secret'] === true) ui['ui:widget'] = 'password';
    const origin = ORIGIN[sources[path] ?? ''];
    if (origin !== undefined) {
      ui['ui:readonly'] = true;
      ui['ui:help'] = origin;
    }
    const properties = isObject(node['properties']) ? node['properties'] : {};
    for (const [key, child] of Object.entries(properties)) {
      const nested = walk(child, path === '' ? key : `${path}.${key}`);
      if (Object.keys(nested).length > 0) ui[key] = nested;
    }
    return ui;
  };
  return walk(schema, '');
}

/** Issues do 400 (`errors[].path` pontilhado) no formato `extraErrors` do rjsf. */
export function fieldErrors(issues: readonly { path: string; message: string }[]): Json {
  const out: Json = {};
  for (const issue of issues) {
    let node = out;
    for (const key of issue.path.split('.').filter((k) => k !== '')) {
      if (!isObject(node[key])) node[key] = {};
      node = node[key] as Json;
    }
    const list = Array.isArray(node['__errors']) ? (node['__errors'] as string[]) : [];
    node['__errors'] = [...list, issue.message];
  }
  return out;
}
