// Guarda da API: junta o resolvedor de ator com a auditoria do kernel (ADR 0127).

import type { Audit } from '#audit/audit.ts';
import { runAsAuditSubject } from '#audit/scope.ts';
import type { AuditSubject } from '#audit/types.ts';
import { createActorResolver } from './actor.ts';
import type { AuthStore } from './store.ts';
import type { ApiActor } from './types.ts';

/** O que `operationHandler` precisa para proteger uma rota. */
export interface ApiGuard {
  authenticate(request: Request): Promise<ApiActor | undefined>;
  /** Registra o 403 na auditoria, com o ator e a operação. */
  denied(actor: ApiActor, operation: string, permission: string, request: Request): void;
  /** Roda `fn` com o ator como titular das gravações de auditoria. */
  run<R>(actor: ApiActor, request: Request, fn: () => R): R;
}

export interface ApiGuardOptions {
  readonly store: AuthStore;
  /** Lido a cada uso: a auditoria nasce depois do servidor HTTP no `createBot`. */
  readonly audit: () => Audit;
  readonly idleMs?: number;
  readonly now?: () => Date;
}

function subject(actor: ApiActor, request: Request): AuditSubject {
  const userAgent = request.headers.get('user-agent');
  return {
    // `AuditActor` não tem `key`: a chave entra como `user` com o id prefixado, sem colidir com usuário.
    actor: {
      kind: 'user',
      id: actor.kind === 'key' ? `key:${actor.id}` : actor.id,
      name: actor.name,
    },
    ...(userAgent !== null && { userAgent }),
  };
}

export function createApiGuard(options: ApiGuardOptions): ApiGuard {
  return {
    authenticate: createActorResolver(options),
    run: (actor, request, fn) => runAsAuditSubject(subject(actor, request), fn),
    denied: (actor, operation, permission, request) =>
      runAsAuditSubject(subject(actor, request), () =>
        options.audit().record({
          action: 'kernel.auth.denied',
          outcome: 'denied',
          target: { type: 'operation', id: operation },
          details: {
            permission,
            ...(actor.onBehalfOf !== undefined && { onBehalfOf: actor.onBehalfOf }),
          },
        }),
      ),
  };
}
