// Config por plugin (M1-13, ADRs 0015 e 0022). Junta as camadas — default do schema < override
// salvo no storage (dashboard) < arquivo (config do app) < env —, valida com o schema Zod do
// plugin, mescla os `messages` sobrescritos e mantém os valores secretos no `SecretSet` que o
// logger consulta. Quem monta o `PluginContext` (M1-16) chama `resolve` a cada setup; uma
// mudança de override é validada antes de salvar e dispara o reload do plugin. Campo `secret` não
// entra por override: o storage guarda em texto puro (ADR 0028).

import type { z } from 'zod';
import * as LOG from '#logger/events.ts';
import { createNoopLogger, MIN_SECRET_LENGTH } from '#logger/logger.ts';
import type { SecretSet } from '#logger/secrets.ts';
import type { LogEvent, Logger } from '#logger/types.ts';
import type { PluginChangeResult } from '#plugin/host.ts';
import { PREFIX_PLACEHOLDER, placeholders } from '#plugin/messages.ts';
import type { PluginDefinition, PluginMessages } from '#plugin/types.ts';
import { kernelStorage } from '#storage/namespace.ts';
import type { JsonObject, JsonValue, StoragePort } from '#storage/types.ts';
import {
  type ConfigEnv,
  type EnvEntry,
  envCollisions,
  envName,
  processEnv,
  readEnvFields,
  readSecretKeys,
} from './env.ts';
import { type ConfigSource, PluginConfigError, type PluginConfigIssue } from './errors.ts';
import { isSecretSchema, misplacedSecrets, objectShape, SECRET_MASK } from './schema.ts';
import { decrypt, encrypt, isEnvelope, keyId } from './secret-cipher.ts';

/**
 * Config de um plugin vinda do app ou do storage: os campos do schema e, opcionalmente,
 * `messages` com textos a sobrescrever (ADR 0022). `messages` é chave reservada.
 */
export type PluginConfigEntry = Readonly<Record<string, unknown>>;

/** "Arquivo" de config: nome do plugin → entrada. É o `pluginConfig` da config do bot. */
export type PluginConfigFile = Readonly<Record<string, PluginConfigEntry>>;

/** O que o contexto do plugin recebe: `ctx.config` e `ctx.plugin.messages`. */
export interface ResolvedPluginConfig {
  /** Saída do schema (defaults aplicados); `undefined` se o plugin não declara `config`. */
  readonly config: unknown;
  /** `messages` do manifesto com as sobrescritas aplicadas. */
  readonly messages: PluginMessages;
}

/** Config para exibição (dashboard, diagnóstico): campos `secret` trocados por `SECRET_MASK`. */
export interface PluginConfigView {
  readonly config: unknown;
  readonly messages: PluginMessages;
  /**
   * Fonte de cada folha da config (`"openai.token"`) e de cada mensagem (`"messages.done"`).
   * Mostra ao dashboard quando um override não vale porque o arquivo ou o env decide o campo.
   */
  readonly sources: Readonly<Record<string, ConfigSource>>;
}

/**
 * JSON Schema (draft 2020-12) da entrada da config; campos secretos com `secret: true`,
 * `writeOnly: true` e `x-bridger-override: false` (não editáveis por override). Com chave mestra
 * (`secretsWritable`), também `x-bridger-set-secret: true`: editável por `setSecret` (ADR 0117).
 */
export type PluginConfigJsonSchema = Readonly<Record<string, unknown>>;

export interface PluginConfigsOptions {
  /** Plugins conhecidos (os mesmos passados ao host). */
  readonly plugins: readonly PluginDefinition[];
  /** Config do app por plugin. */
  readonly file?: PluginConfigFile;
  /** Overrides ficam em `kernelStorage(storage, 'config').kv`, chave = nome do plugin. */
  readonly storage: StoragePort;
  /** Ambiente lido. Padrão: `process.env` (testes injetam o seu). */
  readonly env?: ConfigEnv;
  /** Recebe os valores dos campos `secret` de cada plugin resolvido (compartilhe com o logger). */
  readonly secrets?: SecretSet;
  /** Chamado depois de salvar um override válido; normalmente `(name) => host.reload(name)`. */
  readonly reload?: (plugin: string) => Promise<PluginChangeResult>;
  /**
   * `true` se o plugin está desligado (`disabledPlugins` ou `disable`): `setSecret` e
   * `clearSecret` gravam mas pulam o `reload`, que o host recusaria; o plugin lê o valor ao ligar.
   */
  readonly isDisabled?: (plugin: string) => boolean;
  /** Avisos de configuração (ex.: `pluginConfig` citando plugin inexistente). */
  readonly log?: Logger;
}

export interface PluginConfigs {
  /**
   * Config atual do plugin, validada, e `messages` mesclado. Lança `PluginConfigError` se
   * alguma camada tiver valor inválido. Registra os segredos no `SecretSet`.
   */
  resolve(plugin: string): Promise<ResolvedPluginConfig>;
  /** `true` se há `BRIDGER_SECRET_KEY`: sem ela `setSecret` rejeita (ADR 0117). */
  readonly secretsWritable: boolean;
  /**
   * Salva o segredo `path` (pontilhado, ex.: `openai.apiKey`) do plugin, cifrado no storage.
   * Rejeita com `PluginConfigError` se: não há chave mestra; o caminho não é campo `secret` do
   * schema; o env ou o arquivo definem o campo (`kind: 'shadowed'`); ou a config resultante é
   * inválida. Nesses casos nada muda. Se válida, salva e chama `reload`.
   */
  setSecret(
    plugin: string,
    path: string,
    value: JsonValue,
  ): Promise<PluginChangeResult | undefined>;
  /**
   * Remove o segredo salvo em `path` (o campo volta à camada de baixo) e recarrega. Rejeita se a
   * config ficar inválida (campo obrigatório). Funciona sem chave mestra: é como se limpa um
   * envelope ilegível.
   */
  clearSecret(plugin: string, path: string): Promise<PluginChangeResult | undefined>;
  /**
   * Rotação da chave mestra (ADR 0117): migra para a chave atual os envelopes com o `kid` de
   * `BRIDGER_SECRET_KEY_PREVIOUS`. Devolve quantos migrou. Chamado no boot.
   */
  rotateSecrets(): Promise<number>;
  /**
   * Substitui os overrides do plugin (`{}` remove). Campo `secret` (em qualquer nível) é
   * recusado com `PluginConfigError` (fonte `override`): segredo vem de env, do arquivo ou de
   * `setSecret`.
   * Valida a config resultante antes de salvar:
   * se inválida, rejeita com `PluginConfigError` e nada muda — o plugin segue rodando. Se
   * válida, salva e chama `reload` (devolve o resultado dele; `undefined` sem `reload`).
   * Campo do override que o arquivo ou o env já definem não tem efeito: é salvo mesmo assim
   * (vale se a camada de cima sair) e gera um aviso no log com os caminhos sombreados.
   */
  setOverrides(plugin: string, overrides: JsonObject): Promise<PluginChangeResult | undefined>;
  /** Config atual com os segredos mascarados. Lança `PluginConfigError` se inválida. */
  describe(plugin: string): Promise<PluginConfigView>;
  /** JSON Schema da config para gerar formulário; `undefined` se o plugin não declara `config`. */
  jsonSchema(plugin: string): PluginConfigJsonSchema | undefined;
}

const MESSAGES_KEY = 'messages';

/**
 * Problema da sobrescrita que usa placeholder que o texto padrão não tem (o `{prefix}` vale
 * sempre); `null` se está tudo certo.
 */
function placeholderIssue(text: string, base: string): string | null {
  const allowed = [...placeholders(base), PREFIX_PLACEHOLDER];
  const unknown = placeholders(text).filter((name) => !allowed.includes(name));
  if (unknown.length === 0) return null;
  const show = (names: string[]): string => names.map((name) => `{${name}}`).join(', ');
  return `placeholder desconhecido ${show(unknown)}; a mensagem aceita ${show(allowed)}`;
}
const SECRETS_OWNER = (plugin: string): string => `plugin:${plugin}`;

type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** `top` sobre `base`: objetos mesclam recursivamente; o resto (arrays inclusive) substitui. */
function deepMerge(base: PlainObject, top: PlainObject): PlainObject {
  const merged: PlainObject = { ...base };
  for (const [key, value] of Object.entries(top)) {
    // `undefined` é ausência: não apaga o que veio de camada mais baixa.
    if (value === undefined) continue;
    const current = merged[key];
    merged[key] =
      isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return merged;
}

function setIn(target: PlainObject, path: readonly string[], value: unknown): void {
  let node = target;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (isPlainObject(next)) node = next;
    else {
      const created: PlainObject = {};
      node[key] = created;
      node = created;
    }
  }
  node[path.at(-1) as string] = value;
}

/** `true` se a camada forneceu algum valor no caminho. */
function provides(layer: PlainObject, path: readonly PropertyKey[]): boolean {
  let node: unknown = layer;
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return true;
    if (!(key in node)) return false;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node !== undefined;
}

/** Caminhos das folhas: objetos simples abrem; o resto (arrays inclusive) é folha. */
function leafPaths(value: PlainObject, prefix: readonly string[] = []): string[][] {
  return Object.entries(value).flatMap(([key, child]) => {
    if (child === undefined) return [];
    const path = [...prefix, key];
    return isPlainObject(child) && Object.keys(child).length > 0 ? leafPaths(child, path) : [path];
  });
}

const startsWith = (path: readonly PropertyKey[], prefix: readonly string[]): boolean =>
  prefix.every((key, index) => String(path[index]) === key);

/**
 * Copia `value` trocando cada campo `secret` por `onSecret(valor)`. Percorre só objetos
 * declarados no schema; o que o schema não descreve passa intacto.
 */
function mapSecrets(
  schema: z.ZodType,
  value: unknown,
  onSecret: (value: unknown) => unknown,
): unknown {
  const shape = objectShape(schema);
  if (!shape || !isPlainObject(value)) return value;
  const copy: PlainObject = { ...value };
  for (const [key, field] of Object.entries(shape)) {
    if (copy[key] === undefined) continue;
    copy[key] = isSecretSchema(field)
      ? onSecret(copy[key])
      : mapSecrets(field, copy[key], onSecret);
  }
  return copy;
}

/**
 * Caminhos dos campos `secret` presentes em `value`, seguindo o schema. Mesmo critério de
 * `mapSecrets`: só objetos declarados; `undefined` é ausência.
 */
function secretPaths(
  schema: z.ZodType,
  value: unknown,
  prefix: readonly string[] = [],
): string[][] {
  const shape = objectShape(schema);
  if (!shape || !isPlainObject(value)) return [];
  return Object.entries(shape).flatMap(([key, field]) => {
    if (value[key] === undefined) return [];
    const path = [...prefix, key];
    return isSecretSchema(field) ? [path] : secretPaths(field, value[key], path);
  });
}

/** Valor no caminho de objetos `path` (`undefined` se algum nível faltar). */
function valueAt(value: unknown, path: readonly string[]): unknown {
  let node = value;
  for (const key of path) node = isPlainObject(node) ? node[key] : undefined;
  return node;
}

/** Cópia de `value` sem o campo em `path` (os objetos do caminho são copiados, não alterados). */
function withoutPath(value: PlainObject, path: readonly string[]): PlainObject {
  const [key, ...rest] = path as [string, ...string[]];
  const copy: PlainObject = { ...value };
  const next = copy[key];
  if (rest.length === 0) delete copy[key];
  else if (isPlainObject(next)) copy[key] = withoutPath(next, rest);
  return copy;
}

/** Valores de um campo secreto como texto, para o logger achá-los na linha. */
function secretStrings(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value);
  else if (typeof value === 'number' || typeof value === 'bigint') into.push(String(value));
  else if (Array.isArray(value)) for (const item of value) secretStrings(item, into);
  else if (isPlainObject(value)) for (const item of Object.values(value)) secretStrings(item, into);
}

/** Anotação do JSON Schema que diz ao dashboard que o campo não aceita override. */
const OVERRIDE_ANNOTATION = 'x-bridger-override';
/** Anotação que diz ao dashboard que o campo secreto é editável por `setSecret` (ADR 0117). */
const SET_SECRET_ANNOTATION = 'x-bridger-set-secret';

/**
 * No JSON Schema exportado, marca campo secreto como não editável por override e troca o
 * `default` dele pela máscara. `x-bridger-override` em vez de `readOnly`: o campo já é
 * `writeOnly`, e `readOnly` + `writeOnly` juntos se contradizem no JSON Schema.
 */
function markSecrets(node: unknown, writable: boolean): void {
  if (Array.isArray(node)) {
    for (const item of node) markSecrets(item, writable);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const record = node as PlainObject;
  if (record['secret'] === true) {
    record[OVERRIDE_ANNOTATION] = false;
    if (writable) record[SET_SECRET_ANNOTATION] = true;
    if ('default' in record) record['default'] = SECRET_MASK;
  }
  for (const value of Object.values(record)) markSecrets(value, writable);
}

/**
 * JSON Schema de entrada de um schema Zod, já com os secretos marcados e o `default` deles trocado
 * pela máscara. É o que o dashboard usa em formulários de config e de aba (ADR 0104).
 * Transform não tem JSON Schema; vira `{}` em vez de lançar.
 */
export function maskedJsonSchema(
  schema: z.ZodType,
  secretsWritable = false,
): PluginConfigJsonSchema {
  const json = schema.toJSONSchema({ io: 'input', unrepresentable: 'any' });
  markSecrets(json, secretsWritable);
  return json as PluginConfigJsonSchema;
}

interface Layer {
  readonly source: Exclude<ConfigSource, 'default' | 'env'>;
  readonly fields: PlainObject;
  readonly messages: PlainObject;
}

type Computed =
  | {
      ok: true;
      resolved: ResolvedPluginConfig;
      secrets: string[];
      sources: Record<string, ConfigSource>;
    }
  | { ok: false; error: PluginConfigError };

/** Cria a config dos plugins. Não lê storage nem ambiente até a primeira chamada. */
export function createPluginConfigs(options: PluginConfigsOptions): PluginConfigs {
  const env = options.env ?? processEnv();
  const kv = kernelStorage(options.storage, 'config').kv;
  const secretKv = kernelStorage(options.storage, 'secrets').kv;
  // Chave inválida lança aqui (`BotConfigError`) e derruba o boot (ADR 0117).
  const keys = readSecretKeys(env);
  const decryptKeys = [keys.current, keys.previous].filter((key) => key !== undefined);
  const log = options.log ?? createNoopLogger();
  const file = options.file ?? {};
  const byName = new Map(options.plugins.map((plugin) => [plugin.name, plugin]));

  for (const name of Object.keys(file)) {
    if (!byName.has(name)) {
      log.event(LOG.configUnknownPlugin, { plugin: name });
    }
  }

  let queue: Promise<unknown> = Promise.resolve();
  // Avisa uma vez por campo: `resolve` roda a cada setup/reload/describe.
  const warnedLegacy = new Set<string>();
  const warnedShort = new Set<string>();

  function definitionOf(name: string): PluginDefinition {
    const definition = byName.get(name);
    if (!definition) throw new RangeError(`config: plugin desconhecido "${name}"`);
    return definition;
  }

  /** Separa campos e `messages` de uma entrada; formato errado vira problema da fonte. */
  function toLayer(
    source: Layer['source'],
    raw: unknown,
    issues: PluginConfigIssue[],
  ): Layer | undefined {
    if (raw === undefined) return undefined;
    if (!isPlainObject(raw)) {
      issues.push({
        path: '',
        kind: 'invalid',
        message: 'a config do plugin deve ser um objeto',
        source,
      });
      return undefined;
    }
    const { [MESSAGES_KEY]: messages, ...fields } = raw;
    if (messages !== undefined && !isPlainObject(messages)) {
      issues.push({
        path: MESSAGES_KEY,
        kind: 'invalid',
        message: 'deve ser um objeto chave → texto',
        source,
      });
      return { source, fields, messages: {} };
    }
    return { source, fields, messages: messages ?? {} };
  }

  function compute(
    definition: PluginDefinition,
    override: unknown,
    secretFields: PlainObject,
  ): Computed {
    const { name } = definition;
    const schema = definition.config;
    const shape = schema ? objectShape(schema) : undefined;
    // Erros do autor do plugin, não da config: mensagem direta, sem fonte.
    if (schema && !shape) {
      throw new TypeError(`plugin "${name}": o schema de config deve ser um z.object(...)`);
    }
    if (shape && MESSAGES_KEY in shape) {
      throw new TypeError(
        `plugin "${name}": "${MESSAGES_KEY}" é reservado para sobrescrever textos (ADR 0022) ` +
          'e não pode ser campo do schema de config',
      );
    }
    const misplaced = schema ? misplacedSecrets(schema) : [];
    if (misplaced.length > 0) {
      throw new TypeError(
        `plugin "${name}": secret() só vale em campo de z.object (em qualquer nível de objetos); ` +
          `dentro de array, record ou union ele não seria censurado nem protegido (ADR 0028): ` +
          misplaced.map((path) => `"${path}"`).join(', '),
      );
    }
    const collisions = envCollisions(name, shape, Object.keys(definition.messages ?? {}));
    if (collisions.size > 0) {
      const list = [...collisions].map(([env, paths]) => `${env} (${paths.join(', ')})`);
      throw new TypeError(
        `plugin "${name}": campos diferentes geram a mesma variável de ambiente; renomeie um ` +
          `deles: ${list.join('; ')}`,
      );
    }

    const issues: PluginConfigIssue[] = [];
    // Da menor para a maior precedência.
    const layers = [
      toLayer('override', override, issues),
      toLayer('secret', secretFields, issues),
      toLayer('file', file[name], issues),
    ].filter((layer) => layer !== undefined);
    const envFields = shape ? readEnvFields(name, shape, env) : [];
    const envMessages: EnvEntry[] = Object.keys(definition.messages ?? {}).flatMap((key) => {
      const variable = envName(name, [MESSAGES_KEY, key]);
      const value = env[variable];
      return value === undefined ? [] : [{ path: [key], name: variable, value }];
    });

    let fields: PlainObject = {};
    for (const layer of layers) fields = deepMerge(fields, layer.fields);
    const envLayer: PlainObject = {};
    for (const entry of envFields) setIn(envLayer, entry.path, entry.value);
    fields = deepMerge(fields, envLayer);

    const sourceOf = (path: readonly PropertyKey[]): Omit<PluginConfigIssue, 'message'> => {
      const label = path.map(String).join('.');
      const fromEnv = envFields.find((entry) => startsWith(path, entry.path));
      if (fromEnv) return { path: label, kind: 'invalid', source: 'env', env: fromEnv.name };
      for (const layer of layers.toReversed()) {
        if (provides(layer.fields, path))
          return { path: label, kind: 'invalid', source: layer.source };
      }
      return { path: label, kind: 'invalid', source: 'default' };
    };

    let config: unknown;
    if (!schema) {
      for (const layer of layers) {
        for (const key of Object.keys(layer.fields)) {
          issues.push({
            path: key,
            kind: 'invalid',
            message: 'o plugin não declara config; o campo não tem para onde ir',
            source: layer.source,
          });
        }
      }
    } else {
      const parsed = schema.safeParse(fields);
      if (parsed.success) config = parsed.data;
      else {
        // Só a mensagem do Zod: ela não inclui o valor recebido, que pode ser secreto.
        for (const issue of parsed.error.issues) {
          issues.push({ ...sourceOf(issue.path), message: issue.message });
        }
      }
    }

    const base = definition.messages ?? {};
    const messages: Record<string, string> = { ...base };
    const messageSources: Record<string, ConfigSource> = Object.fromEntries(
      Object.keys(base).map((key) => [`${MESSAGES_KEY}.${key}`, 'default' as const]),
    );
    const messageLayers = [
      ...layers.map((layer) => ({
        entries: Object.entries(layer.messages),
        sourceOf: (): Omit<PluginConfigIssue, 'message' | 'path' | 'kind'> => ({
          source: layer.source,
        }),
      })),
      {
        entries: envMessages.map((entry) => [entry.path[0] as string, entry.value] as const),
        sourceOf: (key: string): Omit<PluginConfigIssue, 'message' | 'path' | 'kind'> => ({
          source: 'env',
          env: envName(name, [MESSAGES_KEY, key]),
        }),
      },
    ];
    for (const layer of messageLayers) {
      for (const [key, text] of layer.entries) {
        const at = {
          path: `${MESSAGES_KEY}.${key}`,
          kind: 'invalid' as const,
          ...layer.sourceOf(key),
        };
        if (!Object.hasOwn(base, key)) {
          const known = Object.keys(base);
          issues.push({
            ...at,
            message:
              `mensagem desconhecida; o plugin declara ` +
              (known.length === 0 ? 'nenhuma' : known.map((k) => `"${k}"`).join(', ')),
          });
        } else if (typeof text !== 'string') {
          issues.push({ ...at, message: 'deve ser texto' });
        } else {
          // O plugin só passa os valores do texto padrão: um placeholder a mais na sobrescrita
          // faria o `ctx.t` lançar na hora de usar, longe da config (ADR 0088).
          const problem = placeholderIssue(text, base[key] as string);
          if (problem !== null) {
            issues.push({ ...at, message: problem });
          } else {
            messages[key] = text;
            messageSources[at.path] = at.source;
          }
        }
      }
    }

    if (issues.length > 0) return { ok: false, error: new PluginConfigError(name, issues) };
    const secrets: string[] = [];
    if (schema) {
      mapSecrets(schema, config, (value) => {
        secretStrings(value, secrets);
        return value;
      });
    }
    // Pelos caminhos da saída: é o que o plugin recebe, defaults inclusive.
    const sources: Record<string, ConfigSource> = {};
    if (isPlainObject(config)) {
      for (const path of leafPaths(config)) sources[path.join('.')] = sourceOf(path).source;
    }
    return {
      ok: true,
      resolved: { config, messages: Object.freeze(messages) },
      secrets,
      sources: { ...sources, ...messageSources },
    };
  }

  /**
   * Override salvo antes da regra de segredos (ou escrito direto no banco) pode ter campo
   * `secret`. O valor é ignorado com aviso em vez de falhar a config: um dado legado não deve
   * desligar o plugin, e o segredo de verdade continua vindo de env ou do arquivo.
   */
  function dropLegacySecrets(definition: PluginDefinition, stored: unknown): unknown {
    if (!definition.config || !isPlainObject(stored)) return stored;
    let clean = stored;
    for (const path of secretPaths(definition.config, stored)) {
      clean = withoutPath(clean, path);
      const label = path.join('.');
      const key = `${definition.name}:${label}`;
      if (warnedLegacy.has(key)) continue;
      warnedLegacy.add(key);
      // Só o caminho: o valor é segredo e ainda não está no `SecretSet`.
      log.event(LOG.configLegacySecret, {
        plugin: definition.name,
        field: label,
        envVar: envName(definition.name, path),
      });
    }
    return clean;
  }

  /**
   * Avisa (uma vez por campo, sem o valor) do segredo curto demais para a censura do log
   * (`MIN_SECRET_LENGTH`): o logger não o censura, e ele sai no log como qualquer texto.
   */
  function warnShortSecrets(definition: PluginDefinition, config: unknown): void {
    if (!definition.config) return;
    for (const path of secretPaths(definition.config, config)) {
      const values: string[] = [];
      secretStrings(valueAt(config, path), values);
      if (!values.some((value) => value.length < MIN_SECRET_LENGTH)) continue;
      const label = path.join('.');
      const key = `${definition.name}:${label}`;
      if (warnedShort.has(key)) continue;
      warnedShort.add(key);
      log.event(LOG.configShortSecret, {
        plugin: definition.name,
        field: label,
        minLength: MIN_SECRET_LENGTH,
      });
    }
  }

  /** Grava os segredos da config resolvida no `SecretSet` e avisa dos curtos demais. */
  function trackSecrets(definition: PluginDefinition, result: Computed & { ok: true }): void {
    warnShortSecrets(definition, result.resolved.config);
    options.secrets?.set(SECRETS_OWNER(definition.name), result.secrets);
  }

  /** Envelopes salvos do plugin: `{ [caminho pontilhado]: envelope }`. */
  async function readStored(name: string): Promise<Record<string, JsonValue>> {
    const stored = await secretKv.get(name);
    return isPlainObject(stored) ? (stored as Record<string, JsonValue>) : {};
  }

  /**
   * Decifra os envelopes na forma de camada de config. `omit` fica de fora: `setSecret` e
   * `clearSecret` trocam esse campo e não podem travar num envelope ilegível dele. Qualquer
   * outro que não decifre lança `PluginConfigError` `undecryptable`, sem valor nem envelope.
   */
  // Quantos envelopes a última chamada de `decryptStored` não decifrou (só útil no modo tolerante).
  let brokenCount = 0;

  function decryptStored(
    name: string,
    stored: Record<string, JsonValue>,
    omit?: string,
    tolerant = false,
  ): PlainObject {
    const fields: PlainObject = {};
    const issues: PluginConfigIssue[] = [];
    for (const [label, envelope] of Object.entries(stored)) {
      if (label === omit) continue;
      try {
        setIn(
          fields,
          label.split('.'),
          JSON.parse(decrypt(decryptKeys, `${name}:${label}`, envelope)),
        );
      } catch {
        issues.push({
          path: label,
          kind: 'undecryptable',
          message:
            'segredo salvo não decifra (BRIDGER_SECRET_KEY ausente ou trocada, ou dado ' +
            'adulterado); restaure a chave ou remova o campo com clearSecret',
          source: 'secret',
        });
      }
    }
    // `tolerant` (clearSecret): os outros ilegíveis ficam de fora, para a remoção não depender deles.
    if (issues.length > 0 && !tolerant) throw new PluginConfigError(name, issues);
    brokenCount = issues.length;
    return fields;
  }

  async function current(name: string): Promise<Computed & { ok: true }> {
    const definition = definitionOf(name);
    const result = compute(
      definition,
      dropLegacySecrets(definition, await kv.get(name)),
      decryptStored(name, await readStored(name)),
    );
    if (!result.ok) throw result.error;
    trackSecrets(definition, result);
    return result;
  }

  /**
   * O dashboard diria "salvo" para um campo que o arquivo ou o env decidem (precedência do
   * ADR 0015/0028). Avisa com caminho e fonte; o valor fica de fora (pode ser sensível).
   */
  function warnShadowed(
    name: string,
    overrides: JsonObject,
    sources: Readonly<Record<string, ConfigSource>>,
  ): void {
    const fields = leafPaths(overrides).flatMap((path) => {
      const label = path.join('.');
      // Folha do override que virou objeto mais em cima: vale a fonte das folhas de baixo.
      const below = Object.entries(sources).filter(
        ([key]) => key === label || key.startsWith(`${label}.`),
      );
      const [first] = below;
      if (!first || below.some(([, source]) => source === 'override')) return [];
      return [{ path: label, source: first[1] }];
    });
    if (fields.length === 0) return;
    log.event(LOG.configOverrideShadowed, { plugin: name, fields });
  }

  async function runSetOverrides(
    name: string,
    overrides: JsonObject,
  ): Promise<PluginChangeResult | undefined> {
    const definition = definitionOf(name);
    // O storage guarda o override em texto puro (banco, backups): segredo não entra (ADR 0028).
    const secretIssues: PluginConfigIssue[] = definition.config
      ? secretPaths(definition.config, overrides).map((path) => ({
          path: path.join('.'),
          kind: 'secret',
          message:
            'campo secreto não pode ser definido por override (o storage guarda em texto ' +
            `puro); defina pela env ${envName(name, path)} ou pelo arquivo ` +
            `pluginConfig["${name}"].${path.join('.')}`,
          source: 'override',
        }))
      : [];
    if (secretIssues.length > 0) throw new PluginConfigError(name, secretIssues);
    const result = compute(definition, overrides, decryptStored(name, await readStored(name)));
    if (!result.ok) throw result.error;
    warnShadowed(name, overrides, result.sources);
    // Antes de salvar e de recarregar: o reload loga, e o segredo novo já precisa sair censurado.
    trackSecrets(definition, result);
    if (Object.keys(overrides).length === 0) await kv.delete(name);
    else await kv.set(name, overrides);
    return options.reload ? options.reload(name) : undefined;
  }

  /** `path` é um campo `secret` do schema (folha, em qualquer nível de objetos)? */
  function isSecretField(schema: z.ZodType | undefined, path: readonly string[]): boolean {
    let shape = schema ? objectShape(schema) : undefined;
    for (const [index, key] of path.entries()) {
      // `hasOwn`: 'constructor' e afins existem em todo objeto e não são campos do schema.
      const field = shape && Object.hasOwn(shape, key) ? shape[key] : undefined;
      if (!field) return false;
      if (index === path.length - 1) return isSecretSchema(field);
      shape = objectShape(field);
    }
    return false;
  }

  /** Persiste o resultado de uma escrita de segredo: valida, grava, loga e recarrega. */
  async function commitSecrets(
    definition: PluginDefinition,
    next: Record<string, JsonValue>,
    fields: PlainObject,
    done: LogEvent,
    label: string,
    lenient = false,
  ): Promise<PluginChangeResult | undefined> {
    const { name } = definition;
    const result = compute(definition, dropLegacySecrets(definition, await kv.get(name)), fields);
    // Remoção com outros envelopes ilegíveis: o estado já era inválido e a remoção não o piora,
    // então a validação não pode bloquear a saída (campo obrigatório ilegível, por exemplo).
    if (!result.ok && !lenient) throw result.error;
    // Antes de salvar e de recarregar: o reload loga, e o segredo novo já precisa sair censurado.
    if (result.ok) trackSecrets(definition, result);
    if (Object.keys(next).length === 0) await secretKv.delete(name);
    else await secretKv.set(name, next);
    // Nunca o valor: só quem, onde e de qual camada.
    log.event(done, {
      plugin: name,
      field: label,
      source: 'secret',
    });
    if (options.isDisabled?.(name)) return undefined;
    return options.reload ? options.reload(name) : undefined;
  }

  async function runSetSecret(
    name: string,
    label: string,
    value: JsonValue,
  ): Promise<PluginChangeResult | undefined> {
    const definition = definitionOf(name);
    const path = label.split('.');
    const refuse = (
      kind: PluginConfigIssue['kind'],
      message: string,
      source: ConfigSource,
      envVar?: string,
    ): PluginConfigError =>
      new PluginConfigError(name, [
        { path: label, kind, message, source, ...(envVar ? { env: envVar } : {}) },
      ]);
    if (!keys.current) {
      throw refuse(
        'invalid',
        'escrita de segredo desligada: defina BRIDGER_SECRET_KEY (32 bytes em base64)',
        'secret',
      );
    }
    if (!isSecretField(definition.config, path)) {
      throw refuse('invalid', 'não é um campo secret() do schema do plugin', 'secret');
    }
    const shape = definition.config ? objectShape(definition.config) : undefined;
    const fromEnv = shape
      ? readEnvFields(name, shape, env).find((entry) => entry.path.join('.') === label)
      : undefined;
    if (fromEnv) {
      throw refuse(
        'shadowed',
        `o campo é definido pela env ${fromEnv.name}, que vale mais que o segredo salvo; ` +
          'remova a variável para gerenciá-lo pelo dashboard',
        'env',
        fromEnv.name,
      );
    }
    const fromFile = file[name];
    if (isPlainObject(fromFile) && provides(fromFile, path)) {
      throw refuse(
        'shadowed',
        `o campo é definido pelo arquivo pluginConfig["${name}"].${label}, que vale mais que o ` +
          'segredo salvo; remova-o do arquivo para gerenciá-lo pelo dashboard',
        'file',
      );
    }
    const stored = await readStored(name);
    const fields = decryptStored(name, stored, label);
    setIn(fields, path, value);
    const next = {
      ...stored,
      [label]: encrypt(keys.current, `${name}:${label}`, JSON.stringify(value)),
    };
    return commitSecrets(definition, next, fields, LOG.configSecretSaved, label);
  }

  async function runClearSecret(
    name: string,
    label: string,
  ): Promise<PluginChangeResult | undefined> {
    const definition = definitionOf(name);
    const stored = await readStored(name);
    const saved = Object.hasOwn(stored, label);
    // Campo que saiu do schema ainda pode ter envelope salvo: deixa limpar.
    if (!saved && !isSecretField(definition.config, label.split('.'))) {
      throw new PluginConfigError(name, [
        {
          path: label,
          kind: 'invalid',
          message: 'não é um campo secret() do schema do plugin',
          source: 'secret',
        },
      ]);
    }
    // Nada salvo no caminho: nada a gravar, logar nem recarregar.
    if (!saved) return undefined;
    const { [label]: _removed, ...next } = stored;
    const fields = decryptStored(name, stored, label, true);
    return commitSecrets(definition, next, fields, LOG.configSecretRemoved, label, brokenCount > 0);
  }

  async function runRotate(): Promise<number> {
    const { current: now, previous } = keys;
    if (!now || !previous) return 0;
    const oldKid = keyId(previous);
    let migrated = 0;
    for (const name of byName.keys()) {
      const stored = await readStored(name);
      const next = { ...stored };
      let changed = false;
      for (const [label, envelope] of Object.entries(stored)) {
        if (!isEnvelope(envelope) || envelope.kid !== oldKid) continue;
        const aad = `${name}:${label}`;
        try {
          next[label] = encrypt(now, aad, decrypt([previous], aad, envelope));
          changed = true;
          migrated++;
        } catch {
          // Fica como está: a resolução do plugin reporta `undecryptable` com o caminho.
          log.event(LOG.configSecretNotMigrated, {
            plugin: name,
            field: label,
          });
        }
      }
      if (changed) await secretKv.set(name, next);
    }
    log.event(LOG.configKeyRotated, { migrated });
    return migrated;
  }

  // Uma mudança por vez: duas gravações concorrentes reordenariam save e reload.
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    resolve: async (name) => (await current(name)).resolved,

    secretsWritable: keys.current !== undefined,

    setOverrides: (name: string, overrides: JsonObject) =>
      enqueue(() => runSetOverrides(name, overrides)),

    setSecret: (name: string, path: string, value: JsonValue) =>
      enqueue(() => runSetSecret(name, path, value)),

    clearSecret: (name: string, path: string) => enqueue(() => runClearSecret(name, path)),

    rotateSecrets: () => enqueue(runRotate),

    async describe(name: string): Promise<PluginConfigView> {
      const definition = definitionOf(name);
      const { resolved, sources } = await current(name);
      const { config, messages } = resolved;
      const masked = definition.config
        ? mapSecrets(definition.config, config, () => SECRET_MASK)
        : config;
      return { config: masked, messages, sources };
    },

    jsonSchema(name: string): PluginConfigJsonSchema | undefined {
      const schema = definitionOf(name).config;
      if (!schema) return undefined;
      // `input`: o formulário preenche a entrada (campos com default são opcionais).
      return maskedJsonSchema(schema, keys.current !== undefined);
    },
  };
}
