// Ator do request: cookie de sessão (pessoa) ou `Authorization: Bearer` (máquina). Sessão vencida,
// revogada ou de usuário desativado, e chave revogada ou desconhecida, não dão ator (ADR 0127).

import { isRole, rolePermissions } from './permissions.ts';
import type { AuthStore } from './store.ts';
import type { ApiActor } from './types.ts';

export const SESSION_COOKIE = 'bridger_session';
export const DEFAULT_IDLE_MS: number = 8 * 60 * 60 * 1000;
export const DEFAULT_MAX_AGE_MS: number = 7 * 24 * 60 * 60 * 1000;

export interface ActorResolverOptions {
  readonly store: AuthStore;
  /** Inatividade máxima entre dois requests da sessão. */
  readonly idleMs?: number;
  readonly now?: () => Date;
}

export function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

export function createActorResolver(
  options: ActorResolverOptions,
): (request: Request) => Promise<ApiActor | undefined> {
  const { store } = options;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const now = options.now ?? (() => new Date());

  async function fromKey(secret: string): Promise<ApiActor | undefined> {
    const key = await store.findApiKeyBySecret(secret);
    if (key === undefined || key.revokedAt !== undefined) return undefined;
    const permissions = await effectivePermissions(key);
    if (permissions === undefined) return undefined;
    await store.touchApiKey(key.id, now());
    return { id: key.id, kind: 'key', name: key.name, permissions };
  }

  // Escopo da chave ∩ permissões atuais do criador (ADR 0128): rebaixar o criador encolhe a chave,
  // desativá-lo a suspende; reativar restaura, sem tocar no storage. Criador-chave vale pela cadeia
  // (termina: o pai sempre é mais antigo). Sem criador (CLI, bootstrap), vale o escopo da chave.
  async function effectivePermissions(key: {
    permissions: readonly string[];
    createdBy: string | null;
  }): Promise<readonly string[] | undefined> {
    if (key.createdBy === null) return key.permissions;
    const user = await store.getUser(key.createdBy);
    if (user !== undefined) {
      if (user.status !== 'active' || !isRole(user.role)) return undefined;
      const allowed = rolePermissions(user.role);
      return key.permissions.filter((p) => allowed.includes(p));
    }
    const parent = await store.getApiKey(key.createdBy);
    if (parent === undefined || parent.revokedAt !== undefined) return undefined;
    const allowed = await effectivePermissions(parent);
    return allowed && key.permissions.filter((p) => allowed.includes(p));
  }

  async function fromSession(token: string): Promise<ApiActor | undefined> {
    const session = await store.findSessionByToken(token);
    if (session === undefined || session.revokedAt !== undefined) return undefined;
    const at = now();
    if (
      at.getTime() >= Date.parse(session.expiresAt) ||
      at.getTime() - Date.parse(session.lastSeenAt) > idleMs
    ) {
      return undefined;
    }
    const user = await store.getUser(session.userId);
    if (user === undefined || user.status !== 'active' || !isRole(user.role)) return undefined;
    // shortcut: uma escrita por request; throttle (ex.: 1/min) se o storage sentir.
    await store.touchSession(session.id, at);
    return {
      id: user.id,
      kind: 'user',
      name: user.name,
      role: user.role,
      permissions: rolePermissions(user.role),
    };
  }

  return async (request) => {
    const bearer = /^Bearer (.+)$/i.exec(request.headers.get('authorization') ?? '');
    // Bearer inválido não cai para o cookie: quem manda credencial de máquina quer ser ela.
    if (bearer?.[1] !== undefined) return fromKey(bearer[1].trim());
    const token = cookie(request, SESSION_COOKIE);
    return token === undefined ? undefined : fromSession(token);
  };
}
