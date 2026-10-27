// Operações da API que pertencem ao core (ADR 0125). As áreas (status, logs, plugins...) entram
// aqui nas tarefas seguintes do M7.

import type { z } from 'zod';
import { keyOperations } from '#auth/keys.ts';
import { type AuthRoutesDeps, authOperations } from '#auth/routes.ts';
import { type AuditApiDeps, auditOperations } from './audit.ts';
import { type ConnectionApiDeps, connectionOperations } from './connection.ts';
import { type EventStream, eventsOperation } from './events.ts';
import { apiLibs, loadApiLibs } from './libs.ts';
import type { AnyApiOperation, ApiRoute } from './operation.ts';
import { type PluginsApiDeps, pluginAdminOperations } from './plugin-admin.ts';
import { type PseudonymApiDeps, pseudonymOperations } from './pseudonyms.ts';

/** O que a API lê do bot da sessão; o servidor só o recebe no `attach`. */
export interface BotApiDeps {
  readonly connection: ConnectionApiDeps;
  readonly stream: EventStream;
  readonly plugins: PluginsApiDeps;
  readonly pseudonyms: PseudonymApiDeps;
  readonly audit: AuditApiDeps;
}

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
  /** Com a auth ligada (`api.auth`), monta as rotas `/auth` e `/users`. */
  auth?: AuthRoutesDeps,
  /** Do bot da sessão: monta `/connection`, `/events` (ADR 0129), `/plugins`, `/pseudonyms` e `/audit`. */
  realtime?: BotApiDeps,
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
    ...(auth ? [...authOperations(auth), ...keyOperations(auth)] : []),
    ...(realtime
      ? [
          ...connectionOperations(realtime.connection),
          eventsOperation(realtime.stream),
          ...pluginAdminOperations(realtime.plugins),
          ...pseudonymOperations(realtime.pseudonyms),
          ...auditOperations(realtime.audit),
        ]
      : []),
  ];
}

/**
 * As rotas do core na sessão `default`, para a spec sem servidor (CLI, snapshot).
 */
export async function coreApiRoutes(): Promise<readonly ApiRoute[]> {
  await loadApiLibs();
  // A spec descreve as rotas de auth e de conexão mesmo sem auth ligada nem bot: o contrato é o mesmo.
  return [
    ...coreApiOperations(),
    ...authOperations(),
    ...keyOperations(),
    ...connectionOperations(),
    eventsOperation(),
    ...pluginAdminOperations(),
    ...pseudonymOperations(),
    ...auditOperations(),
  ].map((operation) => ({
    path: `/api${operation.path}`,
    operation,
  }));
}
