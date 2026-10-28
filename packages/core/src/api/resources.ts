// Recursos de plugin (`api.resources`, ADR 0125 e 0134): o plugin declara dados, schema,
// operações, ações e permissões, e o core os expõe na API e na spec em
// `/api/resources/<plugin>/<id>`. Não há UI aqui: o frontend desenha a partir do schema.

import type { z } from 'zod';
import { isPermission } from '#auth/permissions.ts';
import type { ApiActor } from '#auth/types.ts';
import { BotConfigError } from '#config/owners.ts';
import { apiLibs } from './libs.ts';
import type { AnyApiOperation } from './operation.ts';
import { ApiError } from './problem.ts';

type Awaitable<T> = T | Promise<T>;

/** Quem chama a operação do recurso, para o handler filtrar os dados. */
export interface ResourceActor {
  /** Id do usuário ou da API key. */
  readonly id: string;
  readonly kind: 'user' | 'key';
  readonly name: string;
  /** Pessoa representada pela chave (`X-Bridger-On-Behalf-Of`). */
  readonly onBehalfOf?: string;
  can(permission: string): boolean;
}

/** O que toda operação recebe. `actor` fica `undefined` com a auth desligada (loopback). */
export interface ResourceCall {
  readonly actor: ResourceActor | undefined;
}

/** Ação sobre um item: `POST /api/resources/<plugin>/<recurso>/{id}/actions/<ação>`. */
export interface ResourceAction<
  Input extends z.ZodType = z.ZodType,
  Output extends z.ZodType = z.ZodType,
> {
  /** `[a-z0-9-]`, até 40 caracteres, único no recurso. */
  readonly id: string;
  readonly summary?: string;
  /** Padrão: `permissions.write` do recurso. */
  readonly permission?: string;
  /** Corpo; sem ele, a ação não lê corpo. Inválido é 400. */
  readonly input?: Input;
  /** Resposta; sem ela, a ação responde `{}`. */
  readonly output?: Output;
  /** Dica para o frontend pedir confirmação antes (`x-resource.confirm` na spec). */
  readonly confirm?: boolean;
  run(
    call: ResourceCall & { id: string; input: z.output<Input> },
  ): Awaitable<z.input<Output> | undefined>;
}

/**
 * Recurso contribuído em `ctx.services.contribute('api.resources', ...)`. Toda operação é
 * opcional; a ausente não vira rota. `list` e `get` pedem `permissions.read`; `create`, `update`,
 * `delete` e as ações, `permissions.write` (ou a da ação). Sem a permissão declarada, basta estar
 * autenticado.
 */
export interface ApiResource<
  Item extends z.ZodType = z.ZodType,
  Filter extends z.ZodObject = z.ZodObject,
  Create extends z.ZodType = z.ZodType,
  Update extends z.ZodType = z.ZodType,
> {
  /** `[a-z0-9-]`, até 40 caracteres, único no plugin. */
  readonly id: string;
  readonly summary?: string;
  /** Um item; dê `.meta({ id })` para virar componente nomeado na spec. */
  readonly schema: Item;
  readonly permissions?: { readonly read?: string; readonly write?: string };
  /** Campos de filtro do `list`, na query string (sem `cursor` nem `limit`). */
  readonly filter?: Filter;
  list?(
    call: ResourceCall & { cursor: string | undefined; limit: number; filter: z.output<Filter> },
  ): Awaitable<{ items: z.input<Item>[]; cursor?: string | undefined }>;
  /** `undefined` vira 404. */
  get?(call: ResourceCall & { id: string }): Awaitable<z.input<Item> | undefined>;
  readonly create?: {
    readonly input: Create;
    run(call: ResourceCall & { input: z.output<Create> }): Awaitable<z.input<Item>>;
  };
  readonly update?: {
    readonly input: Update;
    /** `undefined` vira 404. */
    run(
      call: ResourceCall & { id: string; input: z.output<Update> },
    ): Awaitable<z.input<Item> | undefined>;
  };
  /** `false` vira 404. */
  delete?(call: ResourceCall & { id: string }): Awaitable<boolean | undefined>;
  // biome-ignore lint/suspicious/noExplicitAny: cada ação tem os próprios schemas
  readonly actions?: readonly ResourceAction<any, any>[];
}

/** Só tipa: infere o item, o filtro e as entradas a partir dos schemas. */
export function defineResource<
  Item extends z.ZodType,
  Filter extends z.ZodObject = z.ZodObject,
  Create extends z.ZodType = z.ZodType,
  Update extends z.ZodType = z.ZodType,
>(resource: ApiResource<Item, Filter, Create, Update>): ApiResource {
  return resource as unknown as ApiResource;
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const isFn = (value: unknown): boolean => typeof value === 'function';
const isSchema = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && isFn((value as z.ZodType).safeParse);

/** Permissões que o recurso declara, para o catálogo da auth. */
export function resourcePermissions(resource: ApiResource): string[] {
  const out = [resource.permissions?.read, resource.permissions?.write];
  for (const action of resource.actions ?? []) out.push(action.permission);
  return out.filter((p): p is string => p !== undefined);
}

/**
 * Confere a contribuição no `contribute`, para o erro sair no `setup` do plugin e não num 500 ou
 * numa spec quebrada depois. Lê dado de plugin de terceiros: nada é presumido.
 */
export function validateResource(plugin: string, resource: ApiResource): void {
  const fail = (problem: string): never => {
    throw new BotConfigError(`plugin "${plugin}": api.resources ${problem}`);
  };
  if (typeof resource !== 'object' || resource === null) fail('recebeu algo que não é objeto');
  const { id, schema, permissions, filter, create, update, actions } = resource;
  if (typeof id !== 'string' || !ID.test(id))
    fail(`com id inválido: ${String(id)} ([a-z0-9-], até 40)`);
  const where = `"${id}"`;
  if (!isSchema(schema)) fail(`${where} sem schema Zod`);
  for (const p of [permissions?.read, permissions?.write]) {
    if (p !== undefined && !isPermission(p))
      fail(`${where}: permissão "${p}" fora de <área>.<ação>`);
  }
  if (filter !== undefined) {
    const shape = (filter as { shape?: unknown }).shape;
    if (!isSchema(filter) || typeof shape !== 'object' || shape === null) {
      fail(`${where}: filter deve ser z.object(...)`);
    }
    if ('cursor' in (shape as object) || 'limit' in (shape as object)) {
      fail(`${where}: filter não pode ter cursor nem limit (são do core)`);
    }
  }
  for (const [name, op] of [
    ['list', resource.list],
    ['get', resource.get],
    ['delete', resource.delete],
  ] as const) {
    if (op !== undefined && !isFn(op)) fail(`${where}: ${name} deve ser função`);
  }
  for (const [name, op] of [
    ['create', create],
    ['update', update],
  ] as const) {
    if (op !== undefined && !(isSchema(op.input) && isFn(op.run))) {
      fail(`${where}: ${name} precisa de input (schema Zod) e run`);
    }
  }
  if (actions !== undefined && !Array.isArray(actions)) fail(`${where}: actions deve ser array`);
  const seen = new Set<string>();
  for (const action of actions ?? []) {
    if (typeof action?.id !== 'string' || !ID.test(action.id)) {
      fail(`${where}: ação com id inválido: ${String(action?.id)}`);
    }
    if (seen.has(action.id)) fail(`${where}: ação "${action.id}" repetida`);
    seen.add(action.id);
    if (!isFn(action.run)) fail(`${where}: ação "${action.id}" sem run`);
    if (action.permission !== undefined && !isPermission(action.permission)) {
      fail(`${where}: permissão "${action.permission}" fora de <área>.<ação>`);
    }
    for (const schemaOf of [action.input, action.output]) {
      if (schemaOf !== undefined && !isSchema(schemaOf)) {
        fail(`${where}: ação "${action.id}" com input ou output que não é schema Zod`);
      }
    }
  }
  const operations = [resource.list, resource.get, create, update, resource.delete];
  if (operations.every((op) => op === undefined) && seen.size === 0) {
    fail(`${where} sem nenhuma operação (list, get, create, update, delete ou actions)`);
  }
}

function resourceActor(actor: ApiActor | undefined): ResourceActor | undefined {
  if (actor === undefined) return undefined;
  return {
    id: actor.id,
    kind: actor.kind,
    name: actor.name,
    ...(actor.onBehalfOf !== undefined && { onBehalfOf: actor.onBehalfOf }),
    can: (permission) => actor.permissions.includes(permission),
  };
}

/**
 * Operações HTTP do recurso já validado, com `path` relativo a `/api/resources/<plugin>`. Precisa
 * de `loadApiLibs()` antes. `x-resource` diz ao frontend de qual recurso e operação cada rota é,
 * sem ele ter de adivinhar pelo caminho.
 */
export function resourceOperations(plugin: string, resource: ApiResource): AnyApiOperation[] {
  const { z } = apiLibs();
  const { id, schema, permissions, actions = [] } = resource;
  const collection = `/${id}`;
  const item = `/${id}/:id`;
  const tags = [`resources:${plugin}/${id}`];
  const params = z.object({ id: z.string().min(1) });
  const read = permissions?.read;
  const write = permissions?.write;
  const meta = (operation: string, extra: Record<string, unknown> = {}) => ({
    'x-resource': { plugin, resource: id, operation, ...extra },
  });
  const notFound = (): never => {
    throw new ApiError(404, `item não encontrado em ${plugin}/${id}`);
  };
  const out: AnyApiOperation[] = [];
  const add = (operation: AnyApiOperation): void => {
    out.push({ ...operation, tags });
  };

  const { list, get, create, update } = resource;
  const remove = resource.delete;
  if (list !== undefined) {
    const base = z.object({
      cursor: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    });
    add({
      method: 'GET',
      path: collection,
      summary: resource.summary ?? `Lista ${plugin}/${id}`,
      ...(read !== undefined && { permission: read }),
      query: resource.filter === undefined ? base : base.extend(resource.filter.shape),
      response: z.object({ items: z.array(schema), cursor: z.string().optional() }),
      extensions: meta('list'),
      handler: async ({ query, actor }) => {
        const { cursor, limit, ...filter } = query as { cursor?: string; limit: number };
        const page = await list.call(resource, {
          actor: resourceActor(actor),
          cursor,
          limit,
          filter,
        });
        return { items: page.items, ...(page.cursor !== undefined && { cursor: page.cursor }) };
      },
    });
  }
  if (get !== undefined) {
    add({
      method: 'GET',
      path: item,
      summary: `Um item de ${plugin}/${id}`,
      ...(read !== undefined && { permission: read }),
      params,
      response: schema,
      extensions: meta('get'),
      handler: async ({ params: p, actor }) =>
        (await get.call(resource, { actor: resourceActor(actor), id: (p as { id: string }).id })) ??
        notFound(),
    });
  }
  if (create !== undefined) {
    add({
      method: 'POST',
      path: collection,
      summary: `Cria um item em ${plugin}/${id}`,
      ...(write !== undefined && { permission: write }),
      body: create.input,
      response: schema,
      status: 201,
      extensions: meta('create'),
      handler: ({ body, actor }) => create.run({ actor: resourceActor(actor), input: body }),
    });
  }
  if (update !== undefined) {
    add({
      method: 'PATCH',
      path: item,
      summary: `Altera um item de ${plugin}/${id}`,
      ...(write !== undefined && { permission: write }),
      params,
      body: update.input,
      response: schema,
      extensions: meta('update'),
      handler: async ({ params: p, body, actor }) =>
        (await update.run({
          actor: resourceActor(actor),
          id: (p as { id: string }).id,
          input: body,
        })) ?? notFound(),
    });
  }
  if (remove !== undefined) {
    add({
      method: 'DELETE',
      path: item,
      summary: `Remove um item de ${plugin}/${id}`,
      ...(write !== undefined && { permission: write }),
      params,
      response: z.object({ id: z.string() }),
      extensions: meta('delete'),
      handler: async ({ params: p, actor }) => {
        const itemId = (p as { id: string }).id;
        const removed = await remove.call(resource, { actor: resourceActor(actor), id: itemId });
        return removed === false ? notFound() : { id: itemId };
      },
    });
  }
  for (const action of actions) {
    const path = `${item}/actions/${action.id}`;
    const permission = action.permission ?? write;
    add({
      method: 'POST',
      path,
      summary: action.summary ?? `Ação ${action.id} em ${plugin}/${id}`,
      ...(permission !== undefined && { permission }),
      params,
      ...(action.input !== undefined && { body: action.input }),
      response: action.output ?? z.object({}),
      extensions: meta('action', {
        action: action.id,
        ...(action.confirm === true && { confirm: true }),
      }),
      handler: async ({ params: p, body, actor }) =>
        (await action.run({
          actor: resourceActor(actor),
          id: (p as { id: string }).id,
          input: body,
        })) ?? {},
    });
  }
  return out;
}
