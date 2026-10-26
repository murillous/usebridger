// Rotas `/api/keys` (ADR 0127): criar, listar e revogar API keys. Só entram no servidor com
// `api.auth` ligado; na spec (sem servidor) entram com um guarda que nunca é chamado.

import type { z } from 'zod';
import { apiLibs } from '#api/libs.ts';
import type { AnyApiOperation } from '#api/operation.ts';
import { ApiError } from '#api/problem.ts';
import type { ApiGuard } from './guard.ts';
import { CORE_PERMISSIONS } from './permissions.ts';
import type { ApiKeyDoc } from './store.ts';
import type { ApiActor } from './types.ts';

const MAX_NAME = 100;

let schemas:
  | {
      create: z.ZodType;
      params: z.ZodType;
      created: z.ZodType;
      list: z.ZodType;
      revoked: z.ZodType;
    }
  | undefined;

function keySchemas() {
  if (schemas !== undefined) return schemas;
  const { z } = apiLibs();
  const summaryShape = {
    id: z.string(),
    name: z.string(),
    permissions: z.array(z.string()),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
  };
  schemas = {
    create: z
      .object({
        name: z.string().trim().min(1).max(MAX_NAME),
        permissions: z.array(z.string()).min(1),
      })
      .meta({ id: 'ApiKeyCreate' }),
    params: z.object({ id: z.string() }),
    created: z
      .object({
        ...summaryShape,
        secret: z.string().describe('Mostrado uma única vez; só o hash fica guardado.'),
      })
      .meta({ id: 'ApiKeyCreated' }),
    list: z.object({ keys: z.array(z.object(summaryShape).meta({ id: 'ApiKey' })) }),
    revoked: z.object({ id: z.string(), revokedAt: z.string() }),
  };
  return schemas;
}

function summary(id: string, key: ApiKeyDoc) {
  return {
    id,
    name: key.name,
    permissions: key.permissions,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt ?? null,
  };
}

function required(actor: ApiActor | undefined): ApiActor {
  // Com a guarda montada toda rota não pública tem ator; isto só protege o tipo.
  if (actor === undefined) throw new ApiError(401, 'autenticação necessária');
  return actor;
}

/** Precisa de `loadApiLibs()` antes. */
export function keyApiOperations(guard: ApiGuard): readonly AnyApiOperation[] {
  const s = keySchemas();
  const tags = ['keys'];
  return [
    {
      method: 'POST',
      path: '/keys',
      summary: 'Cria uma API key',
      tags,
      permission: 'keys.manage',
      body: s.create,
      response: s.created,
      status: 201,
      handler: async ({ body, actor }) => {
        const who = required(actor);
        const { name, permissions } = body as { name: string; permissions: string[] };
        const scope = [...new Set(permissions)];
        const unknown = scope.filter((p) => !(CORE_PERMISSIONS as readonly string[]).includes(p));
        if (unknown.length > 0) {
          throw new ApiError(400, `permissão desconhecida: ${unknown.join(', ')}`);
        }
        // Delegar o que não se tem seria escalar privilégio por uma chave.
        const missing = scope.filter((p) => !who.permissions.includes(p));
        if (missing.length > 0) {
          throw new ApiError(403, `você não pode conceder: ${missing.join(', ')}`);
        }
        const { secret, id } = await guard.store.createApiKey(
          { name, permissions: scope },
          guard.now(),
        );
        guard.audit().record({
          action: 'kernel.key.created',
          target: { type: 'api-key', id },
          details: { name, permissions: scope },
        });
        const key = await guard.store.getApiKey(id);
        if (key === undefined) throw new Error('api key sumiu logo após a criação');
        return { ...summary(id, key), secret };
      },
    },
    {
      method: 'GET',
      path: '/keys',
      summary: 'Lista as API keys, sem o segredo',
      tags,
      permission: 'keys.manage',
      response: s.list,
      handler: async () => ({
        keys: (await guard.store.listApiKeys()).map(({ id, ...key }) => summary(id, key)),
      }),
    },
    {
      method: 'DELETE',
      path: '/keys/:id',
      summary: 'Revoga uma API key',
      tags,
      permission: 'keys.manage',
      params: s.params,
      response: s.revoked,
      handler: async ({ params }) => {
        const { id } = params as { id: string };
        const key = await guard.store.getApiKey(id);
        if (key === undefined) throw new ApiError(404, 'chave não encontrada');
        // Revogar de novo não regrava a data nem gera outro evento.
        if (key.revokedAt !== undefined) return { id, revokedAt: key.revokedAt };
        const now = guard.now();
        await guard.store.revokeApiKey(id, now);
        guard.audit().record({
          action: 'kernel.key.revoked',
          target: { type: 'api-key', id },
          details: { name: key.name },
        });
        return { id, revokedAt: now.toISOString() };
      },
    },
  ];
}
