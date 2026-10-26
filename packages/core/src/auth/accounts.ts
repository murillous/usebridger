// Regras de usuários, sessões e convites da API (ADR 0127): login com rate limit, convite de uso
// único, papéis, último owner e auditoria. Sem HTTP: as rotas (`routes.ts`) e a CLI de
// recuperação só chamam isto.

import { timingSafeEqual } from 'node:crypto';
import { ApiError } from '#api/problem.ts';
import type { Audit } from '#audit/audit.ts';
import type { PluginStorage, WithId } from '#storage/types.ts';
import { type AuthRole, canManageRole } from './permissions.ts';
import { createLoginLimiter, type LoginLimiter } from './rate-limit.ts';
import {
  generateSecret,
  hashPassword,
  hashSecret,
  verifyPassword,
  WeakPasswordError,
} from './secret.ts';
import type { AuthStore, SessionDoc, UserDoc } from './store.ts';
import type { ApiActor } from './types.ts';

const MAX_CONCURRENT_HASHES = 4;
export const INVITE_TTL_MS: number = 48 * 60 * 60 * 1000;
const INVITE_PREFIX = 'bri_';

type InviteDoc = {
  /** sha256 do token; o token só aparece na resposta que o cria. */
  hash: string;
  userId: string;
  expiresAt: string;
  usedAt?: string;
};

export interface Invite {
  readonly token: string;
  readonly expiresAt: string;
}

export type User = Omit<UserDoc, 'passwordHash'> & {
  readonly id: string;
  /** Convite ainda não aceito (sem senha definida). */
  readonly pendingInvite: boolean;
};

export interface AccountsOptions {
  readonly storage: PluginStorage;
  readonly store: AuthStore;
  /** Lido a cada uso: a auditoria nasce depois do servidor HTTP no `createBot`. */
  readonly audit?: () => Audit;
  readonly now?: () => Date;
  readonly sessionMaxAgeMs: number;
  /** Token que serve de convite do primeiro owner enquanto não há usuário. */
  readonly bootstrapToken?: string;
  readonly limiter?: LoginLimiter;
}

export interface Login {
  readonly token: string;
  readonly user: User;
}

/** 429 do login; a rota devolve `Retry-After`. */
export class TooManyAttempts extends ApiError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(429, `muitas tentativas; tente de novo em ${retryAfterSeconds}s`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Gasta o mesmo scrypt quando a conta não existe, para o tempo da resposta não entregá-la.
let dummyHash: Promise<string> | undefined;
const dummy = (): Promise<string> => {
  dummyHash ??= hashPassword('senha-de-mentira-para-igualar-o-tempo');
  return dummyHash;
};

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(hashSecret(a), 'hex'), Buffer.from(hashSecret(b), 'hex'));
}

type LockDoc = { key: string; until: number };

// Trava curta: as escritas de auth que checam e depois gravam (primeiro owner, e-mail único,
// último owner) levam segundos no máximo; a concessão vence sozinha se o processo morrer dentro.
const LOCK_LEASE_MS = 15_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 15;

type Who = { readonly id: string; readonly name: string };

export function createAccounts(options: AccountsOptions) {
  const { store, storage } = options;
  const now = options.now ?? (() => new Date());
  const limiter = options.limiter ?? createLoginLimiter({ now });
  const users = storage.collection<UserDoc>('users', { indexes: ['email'] });
  const sessions = storage.collection<SessionDoc>('sessions', { indexes: ['hash', 'userId'] });
  const invites = storage.collection<InviteDoc>('invites', { indexes: ['hash', 'userId'] });
  const locks = storage.collection<LockDoc>('locks', { indexes: ['key'] });

  // ADR 0128: o storage não tem transação nem índice unique, então o check-then-write da auth roda
  // sob uma trava feita de duas primitivas atômicas: `increment` por 0 com `insert` cria o
  // documento uma vez só, e o `update` condicional (compare-and-set em `until`) diz quem levou.
  // Vale entre chamadas e entre processos que dividem o banco; a trava é solta mesmo se `fn` falhar.
  async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    await locks.increment({ key }, 'until', 0, { insert: { key, until: 0 } });
    const deadline = Date.now() + LOCK_WAIT_MS;
    let mine: number;
    for (;;) {
      const at = Date.now();
      mine = at + LOCK_LEASE_MS;
      if ((await locks.update({ key, until: { lt: at } }, { until: mine })) > 0) break;
      if (at >= deadline) throw new ApiError(409, 'conta em uso por outra operação; tente de novo');
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
    try {
      return await fn();
    } finally {
      await locks.update({ key, until: mine }, { until: 0 });
    }
  }

  // Sem `actor`, vale o titular do request autenticado; login e convite (sem sessão) passam o seu.
  function record(
    action: string,
    target: string | undefined,
    extra: {
      outcome?: 'denied';
      details?: Record<string, unknown>;
      as?: Who;
      ip?: string | undefined;
    } = {},
  ): void {
    options.audit?.().record({
      action: `kernel.${action}`,
      ...(target !== undefined && { target: { type: 'user', id: target } }),
      ...(extra.outcome && { outcome: extra.outcome }),
      ...(extra.details && { details: extra.details }),
      ...(extra.as && { actor: { kind: 'user' as const, ...extra.as } }),
      ...(extra.ip !== undefined && { ip: extra.ip }),
    });
  }

  function view(doc: WithId<UserDoc>): User {
    const { passwordHash, ...rest } = doc;
    return { ...rest, pendingInvite: passwordHash === '' };
  }

  async function mustGet(id: string): Promise<WithId<UserDoc>> {
    const user = await store.getUser(id);
    if (user === undefined) throw new ApiError(404, 'usuário não encontrado');
    return user;
  }

  function requireManage(actor: ApiActor, target: AuthRole, userId?: string): void {
    // Chave não tem papel: vale o do admin, que não toca em owner.
    if (!canManageRole(actor.role ?? 'admin', target)) {
      record('auth.denied', userId, { outcome: 'denied', details: { reason: 'role', target } });
      throw new ApiError(403, 'seu papel não gerencia esse usuário');
    }
  }

  /**
   * Impede deixar o bot sem owner ativo (desativar ou rebaixar o último). Chame dentro de
   * `withLock('owners')`, junto da escrita, com o usuário lido dentro da trava.
   */
  async function guardLastOwner(user: WithId<UserDoc>): Promise<void> {
    if (user.role !== 'owner' || user.status !== 'active') return;
    const owners = await users.find({ where: { role: 'owner', status: 'active' } });
    if (owners.every((o) => o.id === user.id)) {
      throw new ApiError(409, 'o último owner ativo não pode ser desativado nem rebaixado');
    }
  }

  async function createInvite(userId: string): Promise<Invite> {
    const at = now();
    // Um convite vivo por usuário: o novo invalida o anterior.
    await invites.update({ userId, usedAt: null }, { usedAt: at.toISOString() });
    const token = generateSecret(INVITE_PREFIX);
    const expiresAt = new Date(at.getTime() + INVITE_TTL_MS).toISOString();
    await invites.insert({ hash: hashSecret(token), userId, expiresAt });
    return { token, expiresAt };
  }

  async function startSession(userId: string): Promise<string> {
    const at = now();
    await store.updateUser(userId, { lastLoginAt: at.toISOString() });
    return (await store.createSession({ userId, maxAgeMs: options.sessionMaxAgeMs }, at)).token;
  }

  // Teto de scrypt em andamento: cada um custa ~32 MiB e ~50 ms de CPU, e rajada de login ou
  // convite não pode esgotar a memória. O excedente leva 429 em vez de fila.
  let hashing = 0;
  async function gated<T>(fn: () => Promise<T>): Promise<T> {
    if (hashing >= MAX_CONCURRENT_HASHES) throw new TooManyAttempts(1);
    hashing += 1;
    try {
      return await fn();
    } finally {
      hashing -= 1;
    }
  }

  async function newHash(plain: string): Promise<string> {
    try {
      return await gated(() => hashPassword(plain));
    } catch (error) {
      if (error instanceof WeakPasswordError) throw new ApiError(400, error.message);
      throw error;
    }
  }

  return {
    async login(email: string, plain: string, ip: string | undefined): Promise<Login> {
      const emailKey = `email:${email.toLowerCase()}`;
      const keys = ip === undefined ? [emailKey] : [emailKey, `ip:${ip}`];
      const waitMs = limiter.wait(keys);
      if (waitMs > 0) throw new TooManyAttempts(Math.ceil(waitMs / 1000));
      // A tentativa é contada ANTES do scrypt: rajada paralela não passa do limite enquanto a
      // primeira ainda verifica. Sucesso (ou erro nosso) devolve a reserva.
      limiter.fail(keys);
      let user: Awaited<ReturnType<AuthStore['findUserByEmail']>>;
      let ok: boolean;
      try {
        user = await store.findUserByEmail(email);
        const stored = user?.passwordHash || (await dummy());
        ok = await gated(() => verifyPassword(plain, stored));
      } catch (error) {
        limiter.refund(keys);
        throw error;
      }
      if (!(ok && user !== undefined && user.passwordHash !== '' && user.status === 'active')) {
        record('auth.login.failed', user?.id, { outcome: 'denied', ip });
        // A mesma mensagem para e-mail inexistente, senha errada, conta desativada ou sem senha.
        throw new ApiError(401, 'e-mail ou senha inválidos');
      }
      limiter.reset(emailKey);
      if (ip !== undefined) limiter.refund([`ip:${ip}`]);
      const token = await startSession(user.id);
      record('auth.login', user.id, { as: { id: user.id, name: user.name } });
      return { token, user: view(user) };
    },

    async logout(actor: ApiActor, sessionToken: string | undefined): Promise<void> {
      const session =
        sessionToken === undefined ? undefined : await store.findSessionByToken(sessionToken);
      if (session !== undefined && session.userId === actor.id) {
        await store.revokeSession(session.id, now());
      }
      record('auth.logout', actor.id);
    },

    async listSessions(userId: string): Promise<WithId<SessionDoc>[]> {
      const at = now().getTime();
      const open = await sessions.find({
        where: { userId, revokedAt: null },
        orderBy: 'createdAt',
      });
      return open.filter((s) => Date.parse(s.expiresAt) > at);
    },

    /** Id da sessão dona do token do cookie, para marcar a atual na listagem. */
    async currentSession(token: string): Promise<string | undefined> {
      return (await store.findSessionByToken(token))?.id;
    },

    async revokeOwnSession(userId: string, sessionId: string): Promise<void> {
      const session = await sessions.get(sessionId);
      if (session === undefined || session.userId !== userId) {
        throw new ApiError(404, 'sessão não encontrada');
      }
      await store.revokeSession(sessionId, now());
      record('auth.session.revoked', userId, { details: { sessionId } });
    },

    async changePassword(
      actor: ApiActor,
      current: string,
      next: string,
      keepToken: string | undefined,
    ): Promise<void> {
      const user = await mustGet(actor.id);
      const key = [`pw:${user.id}`];
      const waitMs = limiter.wait(key);
      if (waitMs > 0) throw new TooManyAttempts(Math.ceil(waitMs / 1000));
      if (!(await gated(() => verifyPassword(current, user.passwordHash)))) {
        limiter.fail(key);
        // 403 e não 401: o usuário está autenticado, só errou a confirmação.
        throw new ApiError(403, 'senha atual incorreta');
      }
      limiter.reset(key[0] as string);
      await store.updateUser(user.id, {
        passwordHash: await newHash(next),
        mustChangePassword: false,
      });
      // Troca de senha derruba as outras sessões; a atual continua.
      const keep = keepToken === undefined ? undefined : await store.findSessionByToken(keepToken);
      await sessions.update(
        { userId: user.id, revokedAt: null, ...(keep && { id: { ne: keep.id } }) },
        { revokedAt: now().toISOString() },
      );
      record('auth.password.changed', user.id);
    },

    async acceptInvite(
      input: {
        token: string;
        password: string;
        name?: string | undefined;
        email?: string | undefined;
      },
      ip?: string,
    ): Promise<Login> {
      const invalid = new ApiError(400, 'convite inválido ou expirado');
      const keys = ip === undefined ? [] : [`ip:${ip}`];
      const waitMs = limiter.wait(keys);
      if (waitMs > 0) throw new TooManyAttempts(Math.ceil(waitMs / 1000));
      const reject = (): never => {
        limiter.fail(keys);
        throw invalid;
      };
      const at = now();
      // O token é validado antes do scrypt: chute de convite não custa CPU nem memória.
      const found = (await invites.find({ where: { hash: hashSecret(input.token) }, limit: 1 }))[0];
      let invitee: WithId<UserDoc> | undefined;
      if (found !== undefined) {
        if (found.usedAt !== undefined || Date.parse(found.expiresAt) <= at.getTime()) reject();
        invitee = await store.getUser(found.userId);
        if (invitee === undefined || invitee.status !== 'active') reject();
      } else {
        // Bootstrap: o token da config só vale enquanto não existe nenhum usuário.
        const boot = options.bootstrapToken;
        if (
          boot === undefined ||
          !sameSecret(input.token, boot) ||
          (await users.find({ limit: 1 })).length > 0
        ) {
          reject();
        }
        if (input.name === undefined || input.email === undefined) {
          throw new ApiError(400, 'informe name e email do primeiro owner');
        }
      }
      const hash = await newHash(input.password);
      let userId: string;
      if (found !== undefined && invitee !== undefined) {
        // Uso único: quem marcar primeiro leva; a segunda chamada concorrente recebe 0.
        const claimed = await invites.update(
          { hash: found.hash, usedAt: null },
          { usedAt: at.toISOString() },
        );
        if (claimed === 0) reject();
        await store.updateUser(invitee.id, { passwordHash: hash, mustChangePassword: false });
        userId = invitee.id;
        record('auth.invite.accepted', userId, { as: { id: invitee.id, name: invitee.name } });
      } else {
        const name = input.name as string;
        // Sob a trava, a checagem "sem usuário" e a criação são um passo só: o segundo bootstrap
        // concorrente já vê o owner e é recusado.
        userId = await withLock('users', async () => {
          if ((await users.find({ limit: 1 })).length > 0) return reject();
          return store.createUser(
            { name, email: input.email as string, passwordHash: hash, role: 'owner' },
            at,
          );
        });
        record('auth.invite.accepted', userId, {
          as: { id: userId, name },
          details: { bootstrap: true },
        });
      }
      const token = await startSession(userId);
      return { token, user: view(await mustGet(userId)) };
    },

    async createUser(
      actor: ApiActor,
      input: { name: string; email: string; role: AuthRole },
    ): Promise<{ user: User; invite: Invite }> {
      requireManage(actor, input.role);
      const id = await withLock('users', async () => {
        if ((await store.findUserByEmail(input.email)) !== undefined) {
          throw new ApiError(409, 'já existe usuário com esse e-mail');
        }
        return store.createUser({ ...input, passwordHash: '' }, now());
      });
      const invite = await createInvite(id);
      record('user.created', id, { details: { role: input.role } });
      record('auth.invite.created', id);
      return { user: view(await mustGet(id)), invite };
    },

    async listUsers(): Promise<User[]> {
      return (await users.find({ orderBy: 'createdAt' })).map(view);
    },

    async getUser(id: string): Promise<User> {
      return view(await mustGet(id));
    },

    async updateUser(
      actor: ApiActor,
      id: string,
      patch: { name?: string | undefined; role?: AuthRole | undefined },
    ): Promise<User> {
      const change: Partial<UserDoc> = {
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.role !== undefined && { role: patch.role }),
      };
      await withLock('owners', async () => {
        const user = await mustGet(id);
        requireManage(actor, user.role, id);
        if (patch.role !== undefined && patch.role !== user.role) {
          requireManage(actor, patch.role, id);
          await guardLastOwner(user);
        }
        // O papel vale já: a sessão resolve as permissões pelo papel a cada request.
        await store.updateUser(id, change);
      });
      record('user.updated', id, { details: change });
      return view(await mustGet(id));
    },

    async setStatus(actor: ApiActor, id: string, status: 'active' | 'disabled'): Promise<User> {
      const disabling = status === 'disabled';
      await withLock('owners', async () => {
        const user = await mustGet(id);
        requireManage(actor, user.role, id);
        if (disabling) await guardLastOwner(user);
        await store.updateUser(id, { status });
      });
      if (disabling) {
        await store.revokeUserSessions(id, now());
        record('user.disabled', id);
      } else {
        record('user.enabled', id);
      }
      return view(await mustGet(id));
    },

    async revokeSessions(actor: ApiActor, id: string): Promise<number> {
      const user = await mustGet(id);
      requireManage(actor, user.role, id);
      const count = await store.revokeUserSessions(id, now());
      record('auth.sessions.revoked', id, { details: { count } });
      return count;
    },

    /** Zera a senha (a antiga para de valer), encerra as sessões e gera novo convite. */
    async resetPassword(actor: ApiActor, id: string): Promise<Invite> {
      const user = await mustGet(id);
      requireManage(actor, user.role, id);
      await store.updateUser(id, { passwordHash: '', mustChangePassword: true });
      await store.revokeUserSessions(id, now());
      const invite = await createInvite(id);
      record('auth.invite.created', id, { details: { reset: true } });
      return invite;
    },

    /**
     * Recuperação (CLI): só vale sem owner ativo. Cria o usuário ou promove o existente a owner
     * ativo sem senha, e devolve o convite. Não audita: roda fora do bot, sem a cadeia.
     */
    async recoverOwner(input: { email: string; name?: string | undefined }): Promise<Invite> {
      const id = await withLock('users', () =>
        withLock('owners', async () => {
          if (
            (await users.find({ where: { role: 'owner', status: 'active' }, limit: 1 })).length > 0
          ) {
            throw new ApiError(409, 'já existe owner ativo; a recuperação só vale sem nenhum');
          }
          const existing = await store.findUserByEmail(input.email);
          if (existing !== undefined) {
            await store.updateUser(existing.id, {
              role: 'owner',
              status: 'active',
              passwordHash: '',
            });
            return existing.id;
          }
          if (input.name === undefined) throw new ApiError(400, 'usuário novo: informe --name');
          return store.createUser(
            { name: input.name, email: input.email, passwordHash: '', role: 'owner' },
            now(),
          );
        }),
      );
      await store.revokeUserSessions(id, now());
      return createInvite(id);
    },
  };
}

export type Accounts = ReturnType<typeof createAccounts>;
