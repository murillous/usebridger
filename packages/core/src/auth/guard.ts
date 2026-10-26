// Guarda da API: junta o resolvedor de ator com a auditoria do kernel (ADR 0127).

import { ApiError } from '#api/problem.ts';
import type { Audit } from '#audit/audit.ts';
import { runAsAuditSubject } from '#audit/scope.ts';
import type { AuditSubject } from '#audit/types.ts';
import { createActorResolver } from './actor.ts';
import type { AuthStore } from './store.ts';
import type { ApiActor } from './types.ts';

/** O que `operationHandler` precisa para proteger uma rota. */
export interface ApiGuard {
  authenticate(request: Request): Promise<ApiActor | undefined>;
  /**
   * Aplica `X-Bridger-On-Behalf-Of`: só chave com `auth.on-behalf-of` o usa (senão 403 auditado) e o
   * valor vai para `actor.onBehalfOf`. Sem o header, devolve o mesmo ator.
   */
  delegate(actor: ApiActor, operation: string, request: Request): ApiActor;
  readonly store: AuthStore;
  readonly audit: () => Audit;
  readonly now: () => Date;
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
      ...(actor.onBehalfOf !== undefined && { onBehalfOf: actor.onBehalfOf }),
    },
    ...(userAgent !== null && { userAgent }),
  };
}

export const ON_BEHALF_OF_HEADER = 'x-bridger-on-behalf-of';
export const ON_BEHALF_OF_PERMISSION = 'auth.on-behalf-of';
const ON_BEHALF_OF_MAX = 256;

export function createApiGuard(options: ApiGuardOptions): ApiGuard {
  const guard: ApiGuard = {
    store: options.store,
    audit: options.audit,
    now: options.now ?? (() => new Date()),
    authenticate: createActorResolver(options),
    delegate: (actor, operation, request) => {
      const raw = request.headers.get(ON_BEHALF_OF_HEADER);
      if (raw === null) return actor;
      if (actor.kind !== 'key' || !actor.permissions.includes(ON_BEHALF_OF_PERMISSION)) {
        guard.denied(actor, operation, ON_BEHALF_OF_PERMISSION, request);
        throw new ApiError(403, `permissão necessária: ${ON_BEHALF_OF_PERMISSION}`);
      }
      const value = raw.trim();
      // Vai para o log de auditoria: sem controle e com tamanho limitado.
      if (value === '' || value.length > ON_BEHALF_OF_MAX || /\p{Cc}/u.test(value)) {
        throw new ApiError(400, `${ON_BEHALF_OF_HEADER} inválido`);
      }
      return { ...actor, onBehalfOf: value };
    },
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
  return guard;
}
