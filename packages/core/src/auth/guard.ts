// Guarda da API: junta o resolvedor de ator com a auditoria do kernel (ADR 0127).

import type { Audit } from '#audit/audit.ts';
import { runAsAuditSubject } from '#audit/scope.ts';
import type { AuditSubject } from '#audit/types.ts';
import type { Accounts } from './accounts.ts';
import { createActorResolver } from './actor.ts';
import type { AuthStore } from './store.ts';
import type { ApiActor } from './types.ts';

/** O que `operationHandler` precisa para proteger uma rota. */
export interface ApiGuard {
  /** Usuários e sessões; as rotas `/auth` e `/users` só montam com ele. */
  readonly accounts?: Accounts | undefined;
  readonly sessionMaxAgeMs?: number | undefined;
  authenticate(request: Request): Promise<ApiActor | undefined>;
  /** Registra o 403 na auditoria, com o ator e a operação. */
  denied(
    actor: ApiActor,
    operation: string,
    permission: string,
    request: Request,
    ip?: string,
    /** Motivo que não é falta de permissão (ex.: `csrf`); vai em `details.reason`. */
    reason?: string,
  ): void;
  /** Roda `fn` com o ator como titular das gravações de auditoria. */
  run<R>(actor: ApiActor, request: Request, fn: () => R, ip?: string): R;
  /** IP do cliente: o do socket, ou o do `X-Forwarded-For` com `api.auth.trustProxy`. */
  clientIp(request: Request, socketIp: string | undefined): string | undefined;
}

export interface ApiGuardOptions {
  readonly store: AuthStore;
  /** Lido a cada uso: a auditoria nasce depois do servidor HTTP no `createBot`. */
  readonly audit: () => Audit;
  readonly idleMs?: number;
  readonly accounts?: Accounts;
  readonly sessionMaxAgeMs?: number;
  /** Saltos de proxy confiáveis; 0 (padrão) usa só o endereço do socket. */
  readonly trustProxy?: number;
  readonly now?: () => Date;
}

function subject(actor: ApiActor, request: Request, ip?: string): AuditSubject {
  const userAgent = request.headers.get('user-agent');
  return {
    // `AuditActor` não tem `key`: a chave entra como `user` com o id prefixado, sem colidir com usuário.
    actor: {
      kind: 'user',
      id: actor.kind === 'key' ? `key:${actor.id}` : actor.id,
      name: actor.name,
    },
    ...(ip !== undefined && { ip }),
    ...(userAgent !== null && { userAgent }),
  };
}

export function createApiGuard(options: ApiGuardOptions): ApiGuard {
  return {
    accounts: options.accounts,
    sessionMaxAgeMs: options.sessionMaxAgeMs,
    authenticate: createActorResolver(options),
    run: (actor, request, fn, ip) => runAsAuditSubject(subject(actor, request, ip), fn),
    clientIp: (request, socketIp) => {
      const hops = options.trustProxy ?? 0;
      if (hops <= 0) return socketIp;
      // Cada proxy confiável acrescenta o par que viu à direita; o cliente é o `hops`-ésimo de trás
      // para frente (o que está à esquerda pode ter sido forjado pelo cliente).
      const chain = (request.headers.get('x-forwarded-for') ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');
      return chain[chain.length - hops] ?? socketIp;
    },
    denied: (actor, operation, permission, request, ip, reason) =>
      runAsAuditSubject(subject(actor, request, ip), () =>
        options.audit().record({
          action: 'kernel.auth.denied',
          outcome: 'denied',
          target: { type: 'operation', id: operation },
          details: {
            ...(reason === undefined ? { permission } : { reason }),
            ...(actor.onBehalfOf !== undefined && { onBehalfOf: actor.onBehalfOf }),
          },
        }),
      ),
  };
}
