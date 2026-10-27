// Pseudônimo de volta ao id pela API (ADR 0132): quem investiga um log descobre de quem é o `u_…`.
// Permissão própria, fora dos papéis de leitura, e toda consulta auditada, achando ou não.

import type { z } from 'zod';
import type { Audit } from '#audit/audit.ts';
import { PSEUDONYM_RE } from '#logger/pseudonym.ts';
import type { PseudonymMap } from '#logger/pseudonym-map.ts';
import { apiLibs } from './libs.ts';
import type { AnyApiOperation } from './operation.ts';
import { ApiError } from './problem.ts';

export interface PseudonymApiDeps {
  readonly map: Pick<PseudonymMap, 'resolve' | 'enabled'>;
  /** Getter: a auditoria nasce depois do servidor HTTP no `createBot`. */
  readonly audit: () => Pick<Audit, 'record'>;
}

let schemas: { readonly params: z.ZodType; readonly resolved: z.ZodType } | undefined;

function pseudonymSchemas(): NonNullable<typeof schemas> {
  const { z } = apiLibs();
  schemas ??= {
    params: z.object({
      pseudonym: z.string().regex(PSEUDONYM_RE, 'pseudônimo no formato u_… ou g_… (22 caracteres)'),
    }),
    resolved: z
      .object({
        pseudonym: z.string(),
        kind: z.enum(['user', 'group']),
        id: z
          .string()
          .meta({ description: 'Id como o transport o usa (JID, LID, id do Telegram)' }),
      })
      .meta({ id: 'ResolvedPseudonym' }),
  };
  return schemas;
}

/** Precisa de `loadApiLibs()` antes. Sem `deps` (spec offline), a rota existe só na spec. */
export function pseudonymOperations(deps?: PseudonymApiDeps): readonly AnyApiOperation[] {
  const { params, resolved } = pseudonymSchemas();
  return [
    {
      method: 'GET',
      path: '/pseudonyms/:pseudonym',
      summary: 'Id real de um pseudônimo dos logs',
      tags: ['pseudonyms'],
      // Não termina em `.read`: o `viewer` não a recebe; o id é dado pessoal.
      permission: 'pseudonyms.resolve',
      params,
      response: resolved,
      handler: async ({ params: input }) => {
        if (deps === undefined) throw new ApiError(404);
        const { pseudonym } = input as { pseudonym: string };
        if (!deps.map.enabled) {
          throw new ApiError(
            409,
            'sem BRIDGER_SECRET_KEY os pseudônimos são efêmeros e o mapa não é gravado',
          );
        }
        const id = await deps.map.resolve(pseudonym);
        // Achando ou não: tentar descobrir um contato já é o que se quer rastrear. Sem o id.
        deps.audit().record({
          action: 'kernel.pseudonym.resolve',
          target: { type: 'pseudonym', id: pseudonym },
          outcome: id === undefined ? 'error' : 'success',
          details: { found: id !== undefined },
        });
        if (id === undefined) throw new ApiError(404, 'pseudônimo desconhecido');
        return { pseudonym, kind: pseudonym.startsWith('g_') ? 'group' : 'user', id };
      },
    },
  ];
}
