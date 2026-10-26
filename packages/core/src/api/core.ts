// Operações da API que pertencem ao core (ADR 0125). As áreas (status, logs, plugins...) entram
// aqui nas tarefas seguintes do M7.

import type { z } from 'zod';
import type { ApiGuard } from '#auth/guard.ts';
import { keyApiOperations } from '#auth/keys.ts';
import { apiLibs, loadApiLibs } from './libs.ts';
import type { AnyApiOperation, ApiRoute } from './operation.ts';

let health: z.ZodType | undefined;

function healthSchema(): z.ZodType {
  const { z } = apiLibs();
  health ??= z
    .object({
      status: z.enum(['ok', 'degraded']),
      sessions: z.record(z.string(), z.string()),
    })
    .meta({ id: 'Health' });
  return health;
}

/** Precisa de `loadApiLibs()` antes. `states` lê o estado de cada sessão do servidor; a spec não precisa dele. */
export function coreApiOperations(
  states: () => Record<string, string> = () => ({}),
  guard?: ApiGuard,
): readonly AnyApiOperation[] {
  return [
    {
      method: 'GET',
      path: '/health',
      summary: 'Estado das sessões',
      tags: ['core'],
      // Sonda de orquestrador e load balancer não leva credencial; só expõe o estado das sessões.
      public: true,
      response: healthSchema(),
      handler: () => {
        const sessions = states();
        const ok = Object.values(sessions).every((state) => state === 'running');
        return { status: ok ? 'ok' : 'degraded', sessions };
      },
    },
    // Com a auth ligada (`guard`): rotas de chaves. Blocos das outras entregas da #223 entram aqui.
    ...(guard === undefined ? [] : keyApiOperations(guard)),
  ];
}

const SPEC_GUARD = {} as ApiGuard;

/**
 * As rotas do core na sessão `default`, para a spec sem servidor (CLI, snapshot). `withAuth` junta
 * as rotas que só existem com `api.auth` (chaves); o guarda é de mentira, ninguém chama o handler.
 */
export async function coreApiRoutes(withAuth = false): Promise<readonly ApiRoute[]> {
  await loadApiLibs();
  return coreApiOperations(undefined, withAuth ? SPEC_GUARD : undefined).map((operation) => ({
    path: `/api${operation.path}`,
    operation,
  }));
}
