// Operações da API que pertencem ao core (ADR 0125). As áreas (status, logs, plugins...) entram
// aqui nas tarefas seguintes do M7.

import type { z } from 'zod';
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
): readonly AnyApiOperation[] {
  return [
    {
      method: 'GET',
      path: '/health',
      summary: 'Estado das sessões',
      tags: ['core'],
      response: healthSchema(),
      handler: () => {
        const sessions = states();
        const ok = Object.values(sessions).every((state) => state === 'running');
        return { status: ok ? 'ok' : 'degraded', sessions };
      },
    },
  ];
}

/** As rotas do core na sessão `default`, para a spec sem servidor (CLI, snapshot). */
export async function coreApiRoutes(): Promise<readonly ApiRoute[]> {
  await loadApiLibs();
  return coreApiOperations().map((operation) => ({ path: `/api${operation.path}`, operation }));
}
