// Coleções `users`, `sessions` e `apiKeys` do bot (namespace do kernel). Só acesso de baixo nível:
// as regras (login, convite, rate limit) ficam nas camadas de cima. Datas em ISO 8601 UTC.

import type { Collection, PluginStorage, WithId } from '#storage/types.ts';
import type { AuthRole } from './permissions.ts';
import { generateSecret, hashSecret } from './secret.ts';

export type UserDoc = {
  name: string;
  email: string;
  passwordHash: string;
  role: AuthRole;
  status: 'active' | 'disabled';
  createdAt: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
};

export type SessionDoc = {
  /** sha256 do token do cookie; o token em si nunca é guardado. */
  hash: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  /** Limite absoluto, fixado na criação. */
  expiresAt: string;
  revokedAt?: string;
};

export type ApiKeyDoc = {
  name: string;
  hash: string;
  permissions: string[];
  /** Id do ator que criou (null em chave anterior a isso); a chave não depende dele depois (ADR 0127). */
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt?: string;
};

export type NewUser = Pick<UserDoc, 'name' | 'email' | 'passwordHash' | 'role'> &
  Partial<Pick<UserDoc, 'status' | 'mustChangePassword'>>;

export interface AuthStore {
  createUser(input: NewUser, now: Date): Promise<string>;
  getUser(id: string): Promise<WithId<UserDoc> | undefined>;
  /** O e-mail é único e comparado em minúsculas. */
  findUserByEmail(email: string): Promise<WithId<UserDoc> | undefined>;
  updateUser(id: string, patch: Partial<UserDoc>): Promise<boolean>;

  /** Devolve o token (para o cookie) e o id da sessão. */
  createSession(
    input: { userId: string; maxAgeMs: number },
    now: Date,
  ): Promise<{ token: string; id: string }>;
  findSessionByToken(token: string): Promise<WithId<SessionDoc> | undefined>;
  touchSession(id: string, now: Date): Promise<void>;
  revokeSession(id: string, now: Date): Promise<void>;
  /** Encerra todas as sessões abertas do usuário (desativação, troca de senha). */
  revokeUserSessions(userId: string, now: Date): Promise<number>;

  /** Devolve o segredo uma única vez; o storage guarda só o hash. */
  createApiKey(
    input: { name: string; permissions: readonly string[]; createdBy?: string },
    now: Date,
  ): Promise<{ secret: string; id: string }>;
  getApiKey(id: string): Promise<WithId<ApiKeyDoc> | undefined>;
  /** Todas, inclusive revogadas, da mais antiga para a mais nova. */
  listApiKeys(): Promise<WithId<ApiKeyDoc>[]>;
  findApiKeyBySecret(secret: string): Promise<WithId<ApiKeyDoc> | undefined>;
  touchApiKey(id: string, now: Date): Promise<void>;
  revokeApiKey(id: string, now: Date): Promise<boolean>;
}

export const SESSION_TOKEN_PREFIX = 'brs_';
export const API_KEY_PREFIX = 'brk_';

export function createAuthStore(storage: PluginStorage): AuthStore {
  const users: Collection<UserDoc> = storage.collection<UserDoc>('users', {
    indexes: ['email'],
  });
  const sessions: Collection<SessionDoc> = storage.collection<SessionDoc>('sessions', {
    indexes: ['hash', 'userId'],
  });
  const keys: Collection<ApiKeyDoc> = storage.collection<ApiKeyDoc>('apiKeys', {
    indexes: ['hash'],
  });

  return {
    createUser: (input, now) =>
      users.insert({
        status: 'active',
        mustChangePassword: false,
        ...input,
        email: input.email.toLowerCase(),
        createdAt: now.toISOString(),
        lastLoginAt: null,
      }),
    getUser: (id) => users.get(id),
    findUserByEmail: async (email) =>
      (await users.find({ where: { email: email.toLowerCase() }, limit: 1 }))[0],
    updateUser: async (id, patch) =>
      (await users.update(
        id,
        patch.email === undefined ? patch : { ...patch, email: patch.email.toLowerCase() },
      )) > 0,

    createSession: async ({ userId, maxAgeMs }, now) => {
      const token = generateSecret(SESSION_TOKEN_PREFIX);
      const at = now.toISOString();
      const id = await sessions.insert({
        hash: hashSecret(token),
        userId,
        createdAt: at,
        lastSeenAt: at,
        expiresAt: new Date(now.getTime() + maxAgeMs).toISOString(),
      });
      return { token, id };
    },
    findSessionByToken: async (token) =>
      (await sessions.find({ where: { hash: hashSecret(token) }, limit: 1 }))[0],
    touchSession: async (id, now) => {
      await sessions.update(id, { lastSeenAt: now.toISOString() });
    },
    revokeSession: async (id, now) => {
      await sessions.update(id, { revokedAt: now.toISOString() });
    },
    // `revokedAt` ausente vale null: só as ainda abertas.
    revokeUserSessions: (userId, now) =>
      sessions.update({ userId, revokedAt: null }, { revokedAt: now.toISOString() }),

    createApiKey: async ({ name, permissions, createdBy }, now) => {
      const secret = generateSecret(API_KEY_PREFIX);
      const id = await keys.insert({
        name,
        hash: hashSecret(secret),
        permissions: [...permissions],
        createdBy: createdBy ?? null,
        createdAt: now.toISOString(),
        lastUsedAt: null,
      });
      return { secret, id };
    },
    getApiKey: (id) => keys.get(id),
    listApiKeys: () => keys.find(),
    findApiKeyBySecret: async (secret) =>
      (await keys.find({ where: { hash: hashSecret(secret) }, limit: 1 }))[0],
    touchApiKey: async (id, now) => {
      await keys.update(id, { lastUsedAt: now.toISOString() });
    },
    revokeApiKey: async (id, now) => (await keys.update(id, { revokedAt: now.toISOString() })) > 0,
  };
}
