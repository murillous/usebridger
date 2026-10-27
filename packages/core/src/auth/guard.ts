// Guarda da API: junta o resolvedor de ator com a auditoria do kernel (ADR 0127).

import { ApiError } from '#api/problem.ts';
import type { Audit } from '#audit/audit.ts';
import { runAsAuditSubject } from '#audit/scope.ts';
import type { AuditSubject } from '#audit/types.ts';
import type { Accounts } from './accounts.ts';
import { createActorResolver } from './actor.ts';
import type { AuthStore } from './store.ts';
import type { ApiActor } from './types.ts';

export interface KeysDeps {
  readonly store: AuthStore;
  readonly audit: () => Audit;
  readonly now: () => Date;
  /** Permissões declaradas pelos plugins carregados, aceitas no escopo da chave (ADR 0134). */
  readonly pluginPermissions: () => readonly string[];
}

/** O que `operationHandler` precisa para proteger uma rota. */
export interface ApiGuard {
  /** Usuários e sessões; as rotas `/auth` e `/users` só montam com ele. */
  readonly accounts?: Accounts | undefined;
  readonly sessionMaxAgeMs?: number | undefined;
  authenticate(request: Request): Promise<ApiActor | undefined>;
  /**
   * Aplica `X-Bridger-On-Behalf-Of`: só chave com `auth.on-behalf-of` o usa (senão 403 auditado) e o
   * valor vai para `actor.onBehalfOf`. Sem o header, devolve o mesmo ator.
   */
  delegate(actor: ApiActor, operation: string, request: Request): ApiActor;
  /** O que as rotas de chaves precisam (`/api/keys`). */
  readonly keys: KeysDeps;
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
  /** Permissões declaradas pelos plugins carregados; lido a cada request (ADR 0134). */
  readonly pluginPermissions?: () => readonly string[];
}

function subject(actor: ApiActor, request: Request, ip?: string): AuditSubject {
  const userAgent = request.headers.get('user-agent');
  return {
    // `AuditActor` não tem `key`: a chave entra como `user` com o id prefixado, sem colidir com usuário.
    actor: {
      kind: 'user',
      id: actor.kind === 'key' ? `key:${actor.id}` : actor.id,
      name: actor.name,
      ...(actor.onBehalfOf !== undefined && { onBehalfOf: actor.onBehalfOf }),
    },
    ...(ip !== undefined && { ip }),
    ...(userAgent !== null && { userAgent }),
  };
}

export const ON_BEHALF_OF_HEADER = 'x-bridger-on-behalf-of';
export const ON_BEHALF_OF_PERMISSION = 'auth.on-behalf-of';
const ON_BEHALF_OF_MAX = 256;

export function createApiGuard(options: ApiGuardOptions): ApiGuard {
  const guard: ApiGuard = {
    keys: {
      store: options.store,
      audit: options.audit,
      now: options.now ?? (() => new Date()),
      pluginPermissions: options.pluginPermissions ?? (() => []),
    },
    accounts: options.accounts,
    sessionMaxAgeMs: options.sessionMaxAgeMs,
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
  return guard;
}
