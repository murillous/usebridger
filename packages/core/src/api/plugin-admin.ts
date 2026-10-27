// Plugins e config pela API (ADR 0125, 0131): listar, ligar e desligar, ler e gravar a config com os
// segredos cifrados (ADR 0117). As escritas passam pelo `bot.plugins`/`bot.config`, que gravam a
// auditoria (ADR 0122) em nome do ator da requisição, sem o valor de segredo.

import type { z } from 'zod';
import type { BotPluginConfigs, BotPlugins } from '#bot/config.ts';
import { BotStateError } from '#bot/config.ts';
import { PluginConfigError } from '#config/errors.ts';
import { SECRET_MASK } from '#config/schema.ts';
import { PluginHostStateError } from '#plugin/host.ts';
import { describeSkipReason, type PluginReportEntry } from '#plugin/report.ts';
import type { JsonObject, JsonValue } from '#storage/types.ts';
import { apiLibs } from './libs.ts';
import type { AnyApiOperation } from './operation.ts';
import { ApiError } from './problem.ts';

export interface PluginsApiDeps {
  readonly plugins: BotPlugins;
  readonly config: BotPluginConfigs;
  /** Campos `secret` do schema do plugin (`openai.apiKey`): o `PUT` os separa dos overrides. */
  readonly secretFields: (plugin: string) => readonly string[];
  /** Censura os segredos conhecidos: mensagem de erro de plugin pode citar um. */
  readonly redact: <T>(value: T) => T;
}

let schemas:
  | {
      readonly list: z.ZodType;
      readonly change: z.ZodType;
      readonly config: z.ZodType;
      readonly name: z.ZodType;
      readonly body: z.ZodType;
    }
  | undefined;

function pluginSchemas(): NonNullable<typeof schemas> {
  if (schemas !== undefined) return schemas;
  const { z } = apiLibs();
  const plugin = z
    .object({
      name: z.string(),
      version: z.string(),
      origin: z.string(),
      status: z.enum(['loaded', 'skipped']),
      dependsOn: z.record(z.string(), z.string()).optional(),
      optionalDependsOn: z.record(z.string(), z.string()).optional(),
      setupMs: z.number().optional(),
      services: z.array(z.string()).optional(),
      contributions: z.array(z.string()).optional(),
      contributionCounts: z.record(z.string(), z.number()).optional(),
      unregistered: z
        .array(
          z.object({
            command: z.string(),
            missing: z.array(z.string()),
            services: z.array(z.string()).optional(),
          }),
        )
        .optional(),
      reason: z
        .object({ kind: z.string(), message: z.string() })
        .optional()
        .meta({ description: 'Por que não carregou (só com `status: skipped`)' }),
    })
    .meta({ id: 'Plugin' });
  schemas = {
    list: z
      .object({
        bootedAt: z.number().nullable().meta({ description: 'Fim do boot dos plugins (epoch ms)' }),
        plugins: z.array(plugin),
      })
      .meta({ id: 'PluginList' }),
    change: z.object({ plugin, dependents: z.array(plugin) }).meta({ id: 'PluginChange' }),
    config: z
      .object({
        view: z
          .object({
            config: z.unknown(),
            messages: z.record(z.string(), z.string()),
            sources: z.record(z.string(), z.string()),
          })
          .nullable()
          .meta({ description: `Config atual, segredos como "${SECRET_MASK}"; null se inválida` }),
        schema: z
          .record(z.string(), z.unknown())
          .nullable()
          .meta({ description: 'JSON Schema da entrada; null se o plugin não tem config' }),
        secretsWritable: z.boolean(),
        issues: z
          .array(z.object({ path: z.string(), message: z.string(), kind: z.string() }))
          .optional()
          .meta({ description: 'Por que a config atual é inválida (com `view: null`)' }),
      })
      .meta({ id: 'PluginConfig' }),
    name: z.object({ name: z.string() }),
    body: z.record(z.string(), z.unknown()).meta({
      description: `Overrides (substituem os salvos). Segredo com "${SECRET_MASK}" mantém o valor; outro valor grava o segredo cifrado`,
    }),
  };
  return schemas;
}

/** Linha da tabela de boot em JSON seguro: o motivo vira texto, nunca o erro com `cause`. */
function serialize(entry: PluginReportEntry, redact: <T>(value: T) => T) {
  const { name, version, origin, dependsOn, optionalDependsOn } = entry;
  const base = {
    name,
    version,
    origin,
    ...(dependsOn && { dependsOn }),
    ...(optionalDependsOn && { optionalDependsOn }),
  };
  if (entry.status === 'skipped') {
    const message = redact(describeSkipReason(entry.reason)).slice(0, 300);
    return { ...base, status: entry.status, reason: { kind: entry.reason.kind, message } };
  }
  const { setupMs, services, contributions, contributionCounts, unregistered } = entry;
  return {
    ...base,
    status: entry.status,
    ...(setupMs !== undefined && { setupMs }),
    ...(services && { services }),
    ...(contributions && { contributions }),
    ...(contributionCounts && { contributionCounts }),
    ...(unregistered && { unregistered }),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function valueAt(value: unknown, path: readonly string[]): unknown {
  let node = value;
  for (const key of path) node = isObject(node) && Object.hasOwn(node, key) ? node[key] : undefined;
  return node;
}

/**
 * Cópia sem o campo em `path`; os objetos do caminho são copiados, não alterados. O objeto que
 * fica vazio sai também: `{ openai: {} }` como override invalidaria o `openai.apiKey` obrigatório.
 */
function without(value: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
  const [key, ...rest] = path as [string, ...string[]];
  const copy = { ...value };
  const next = copy[key];
  if (rest.length === 0) delete copy[key];
  else if (isObject(next)) {
    const inner = without(next, rest);
    if (Object.keys(inner).length === 0) delete copy[key];
    else copy[key] = inner;
  }
  return copy;
}

/**
 * Tira os segredos do corpo: o que vem com a máscara (ou não vem) fica como está; o resto é
 * segredo novo. Os overrides nunca levam segredo, que o storage guardaria em texto puro.
 */
function splitSecrets(
  body: Record<string, unknown>,
  fields: readonly string[],
): { overrides: JsonObject; secrets: [string, JsonValue][] } {
  let overrides = body;
  const secrets: [string, JsonValue][] = [];
  for (const label of fields) {
    const path = label.split('.');
    const value = valueAt(overrides, path);
    if (value === undefined) continue;
    overrides = without(overrides, path);
    if (value !== SECRET_MASK) secrets.push([label, value as JsonValue]);
  }
  return { overrides: overrides as JsonObject, secrets };
}

/** Erro esperado do core vira problem+json; o resto sobe para o 500 com log. */
function translate(error: unknown, redact: <T>(value: T) => T): never {
  if (error instanceof PluginConfigError) {
    // `shadowed`: o env ou o arquivo decidem o campo; é conflito de estado, não valor ruim.
    const status = error.issues.some((issue) => issue.kind === 'shadowed') ? 409 : 400;
    throw new ApiError(
      status,
      'config recusada',
      // A mensagem do core nunca leva o valor recebido.
      error.issues.map(({ path, message, kind }) => ({ in: 'body', path, message, code: kind })),
    );
  }
  if (error instanceof PluginHostStateError || error instanceof BotStateError) {
    throw new ApiError(409, redact(error.message).slice(0, 300));
  }
  throw error;
}

/** Precisa de `loadApiLibs()` antes. Sem `deps` (spec offline), as rotas existem só na spec. */
export function pluginAdminOperations(deps?: PluginsApiDeps): readonly AnyApiOperation[] {
  const { list, change, config, name, body } = pluginSchemas();
  const need = (plugin?: string): PluginsApiDeps => {
    if (deps === undefined) throw new ApiError(404);
    // 404 antes do core: um erro do `.transform` do plugin não se confunde com plugin desconhecido.
    if (plugin !== undefined && !deps.plugins().some((entry) => entry.name === plugin)) {
      throw new ApiError(404, `plugin desconhecido: ${plugin}`);
    }
    return deps;
  };

  async function view(current: PluginsApiDeps, plugin: string) {
    const schema = current.config.jsonSchema(plugin) ?? null;
    const { secretsWritable } = current.config;
    try {
      const { config: values, messages, sources } = await current.config.describe(plugin);
      return { view: { config: values, messages, sources }, schema, secretsWritable };
    } catch (error) {
      // Config atual inválida: é quando mais se precisa do formulário para corrigir.
      if (!(error instanceof PluginConfigError)) throw error;
      const issues = error.issues.map(({ path, message, kind }) => ({ path, message, kind }));
      return { view: null, schema, secretsWritable, issues };
    }
  }

  const toggle = (action: 'enable' | 'disable'): AnyApiOperation => ({
    method: 'POST',
    path: `/plugins/:name/${action}`,
    summary:
      action === 'enable' ? 'Liga o plugin e os dependentes' : 'Desliga o plugin e os dependentes',
    tags: ['plugins'],
    permission: 'plugins.manage',
    params: name,
    response: change,
    handler: async ({ params }) => {
      const plugin = (params as { name: string }).name;
      const current = need(plugin);
      try {
        const result = await current.plugins[action](plugin);
        return {
          plugin: serialize(result.plugin, current.redact),
          dependents: result.dependents.map((entry) => serialize(entry, current.redact)),
        };
      } catch (error) {
        return translate(error, current.redact);
      }
    },
  });

  return [
    {
      method: 'GET',
      path: '/plugins',
      summary: 'Plugins: versão, estado, dependências, serviços e contribuições',
      tags: ['plugins'],
      permission: 'plugins.read',
      response: list,
      handler: () => {
        const { plugins, redact } = need();
        return {
          bootedAt: plugins.bootedAt ?? null,
          plugins: plugins().map((entry) => serialize(entry, redact)),
        };
      },
    },
    toggle('enable'),
    toggle('disable'),
    {
      method: 'GET',
      path: '/plugins/:name/config',
      summary: 'Config atual (segredos mascarados) e JSON Schema',
      tags: ['plugins'],
      permission: 'config.read',
      params: name,
      response: config,
      handler: ({ params }) => {
        const plugin = (params as { name: string }).name;
        return view(need(plugin), plugin);
      },
    },
    {
      method: 'PUT',
      path: '/plugins/:name/config',
      summary: 'Grava a config: overrides e segredos (validados no schema do plugin)',
      tags: ['plugins'],
      permission: 'config.write',
      params: name,
      body,
      response: config,
      handler: async ({ params, body: input, actor }) => {
        const plugin = (params as { name: string }).name;
        const current = need(plugin);
        const { overrides, secrets } = splitSecrets(
          input as Record<string, unknown>,
          current.secretFields(plugin),
        );
        // Auth desligada (`actor` ausente) não tem permissão a conferir, como no resto da API.
        if (
          secrets.length > 0 &&
          actor !== undefined &&
          !actor.permissions.includes('secrets.write')
        ) {
          throw new ApiError(403, 'permissão necessária: secrets.write');
        }
        try {
          // Segredos antes: um override que só valida com o segredo novo passa na mesma chamada.
          // shortcut: não é atômico; um override inválido depois de um segredo gravado deixa o
          // segredo salvo. Uma escrita única no `PluginConfigs` resolve se isso incomodar.
          for (const [path, value] of secrets) await current.config.setSecret(plugin, path, value);
          await current.config.setOverrides(plugin, overrides);
        } catch (error) {
          return translate(error, current.redact);
        }
        return view(current, plugin);
      },
    },
  ];
}
