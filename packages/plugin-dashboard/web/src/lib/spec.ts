// Recursos de plugin lidos do `GET /openapi.json` (ADR 0134): cada operação traz `x-resource`, e a
// tela genérica monta lista, detalhe, formulários e ações só com isso, sem código do plugin.

export type JsonSchema = Record<string, unknown>;

interface SpecParameter {
  in: string;
  name: string;
  required?: boolean;
  schema?: JsonSchema;
  description?: string;
}

interface SpecOperation {
  summary?: string;
  'x-permission'?: string;
  'x-resource'?: {
    plugin: string;
    resource: string;
    operation: string;
    action?: string;
    confirm?: boolean;
  };
  parameters?: SpecParameter[];
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
}

export interface OpenApiDocument {
  paths?: Record<string, Record<string, SpecOperation>>;
  components?: { schemas?: Record<string, JsonSchema> };
}

export interface ResourceOperation {
  /** Caminho relativo à API da sessão; o item usa `{id}`. */
  readonly path: string;
  readonly permission?: string;
  readonly summary?: string;
  /** Corpo (create, update, ação), já sem `$ref`. */
  readonly input?: JsonSchema;
}

export interface ResourceAction extends ResourceOperation {
  readonly id: string;
  readonly confirm: boolean;
}

export interface FilterField {
  readonly name: string;
  readonly schema: JsonSchema;
  readonly description?: string;
}

export interface ResourceView {
  /** `<plugin>/<recurso>`: o endereço da tela. */
  readonly key: string;
  readonly plugin: string;
  readonly resource: string;
  readonly summary?: string;
  /** Schema do item (da resposta do `get` ou do `list`), sem `$ref`. */
  readonly item?: JsonSchema;
  readonly filters: readonly FilterField[];
  readonly list?: ResourceOperation;
  readonly get?: ResourceOperation;
  readonly create?: ResourceOperation;
  readonly update?: ResourceOperation;
  readonly delete?: ResourceOperation;
  readonly actions: readonly ResourceAction[];
}

type Mutable = {
  -readonly [K in keyof ResourceView]: ResourceView[K] extends readonly (infer T)[]
    ? T[]
    : ResourceView[K];
};

/** Troca `$ref` de `#/components/schemas/X` pelo schema; ciclo vira `{}` (o form mostra JSON livre). */
export function deref(schema: unknown, spec: OpenApiDocument, seen: string[] = []): unknown {
  if (Array.isArray(schema)) return schema.map((item) => deref(item, spec, seen));
  if (typeof schema !== 'object' || schema === null) return schema;
  const ref = (schema as { $ref?: unknown }).$ref;
  if (typeof ref === 'string') {
    const name = ref.replace('#/components/schemas/', '');
    const target = spec.components?.schemas?.[name];
    if (target === undefined || seen.includes(name)) return {};
    return deref(target, spec, [...seen, name]);
  }
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [key, deref(value, spec, seen)]),
  );
}

const json = (content: Record<string, { schema?: JsonSchema }> | undefined) =>
  content?.['application/json']?.schema;

/** Recursos da sessão cujo caminho começa em `apiPath` (`/api`, `/sessions/erp/api`). */
export function resourcesFromSpec(spec: OpenApiDocument, apiPath: string): ResourceView[] {
  const views = new Map<string, Mutable>();
  for (const [fullPath, item] of Object.entries(spec.paths ?? {})) {
    if (!fullPath.startsWith(`${apiPath}/resources/`)) continue;
    const path = fullPath.slice(apiPath.length);
    for (const operation of Object.values(item)) {
      const meta = operation['x-resource'];
      if (meta === undefined) continue;
      const key = `${meta.plugin}/${meta.resource}`;
      const view: Mutable = views.get(key) ?? {
        key,
        plugin: meta.plugin,
        resource: meta.resource,
        filters: [],
        actions: [],
      };
      views.set(key, view);
      const success = Object.entries(operation.responses ?? {}).find(([code]) =>
        code.startsWith('2'),
      )?.[1];
      const response = deref(json(success?.content), spec) as JsonSchema | undefined;
      const input = deref(json(operation.requestBody?.content), spec) as JsonSchema | undefined;
      const base: ResourceOperation = {
        path,
        ...(operation['x-permission'] !== undefined && { permission: operation['x-permission'] }),
        ...(operation.summary !== undefined && { summary: operation.summary }),
        ...(input !== undefined && { input }),
      };
      switch (meta.operation) {
        case 'list': {
          view.list = base;
          view.summary = operation.summary;
          const items = (response?.['properties'] as Record<string, JsonSchema> | undefined)?.[
            'items'
          ];
          view.item ??= items?.['items'] as JsonSchema | undefined;
          view.filters = (operation.parameters ?? [])
            .filter((p) => p.in === 'query' && p.name !== 'cursor' && p.name !== 'limit')
            .map((p) => ({
              name: p.name,
              schema: (deref(p.schema, spec) as JsonSchema | undefined) ?? {},
              ...(p.description !== undefined && { description: p.description }),
            }));
          break;
        }
        case 'get':
          view.get = base;
          // O `get` devolve o item inteiro: vale mais que o do `list`.
          if (response !== undefined) view.item = response;
          break;
        case 'create':
          view.create = base;
          break;
        case 'update':
          view.update = base;
          break;
        case 'delete':
          view.delete = base;
          break;
        case 'action':
          if (meta.action !== undefined) {
            view.actions.push({ ...base, id: meta.action, confirm: meta.confirm === true });
          }
          break;
      }
    }
  }
  return [...views.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** `/resources/rank/ranking/{id}` com o id do item, escapado. */
export const itemPath = (path: string, id: string): string =>
  path.replace('{id}', encodeURIComponent(id));
