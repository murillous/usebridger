// Rotas `/api/auth/...` e `/api/users/...` (ADR 0127): login por cookie, convites e usuários.

import { apiLibs } from '#api/libs.ts';
import type { AnyApiOperation } from '#api/operation.ts';
import { ApiError, problemResponse } from '#api/problem.ts';
import { type Accounts, type Login, TooManyAttempts } from './accounts.ts';
import { cookie, SESSION_COOKIE } from './actor.ts';
import { ROLES } from './permissions.ts';
import type { ApiActor } from './types.ts';

export interface AuthRoutesDeps {
  readonly accounts: Accounts;
  readonly sessionMaxAgeMs: number;
  /** `api.cors.origins`: com a origem do request na lista, o cookie sai `SameSite=None`. */
  readonly corsOrigins?: readonly string[] | undefined;
  /** Path do cookie: `<prefixo da sessão>/api`. */
  readonly cookiePath: string;
}

/** Cookie da sessão; `maxAgeSeconds` 0 apaga. Origem cruzada exige `SameSite=None; Secure`. */
function setCookie(deps: AuthRoutesDeps, request: Request, token: string, maxAge: number): string {
  const origin = request.headers.get('origin');
  const cross = origin !== null && deps.corsOrigins?.includes(origin) === true;
  return `${SESSION_COOKIE}=${token}; Path=${deps.cookiePath}; HttpOnly; Secure; SameSite=${cross ? 'None' : 'Strict'}; Max-Age=${maxAge}`;
}

function loggedIn(deps: AuthRoutesDeps, request: Request, login: Login): Response {
  const maxAge = Math.floor(deps.sessionMaxAgeMs / 1000);
  return new Response(JSON.stringify({ user: login.user }), {
    headers: {
      'content-type': 'application/json',
      'set-cookie': setCookie(deps, request, login.token, maxAge),
    },
  });
}

/** `actor` sempre existe nas rotas não públicas com a auth ligada; sem ele é 401. */
function need(actor: ApiActor | undefined): ApiActor {
  if (actor === undefined) throw new ApiError(401, 'autenticação necessária');
  return actor;
}

/** Rotas de "minha conta" (sessão, senha) são de pessoa: API key não tem conta. */
function needUser(actor: ApiActor | undefined): ApiActor {
  const found = need(actor);
  if (found.kind === 'key') throw new ApiError(403, 'rota de usuário: não vale para API key');
  return found;
}

/**
 * Operações de autenticação e de usuários. Sem `deps` só descrevem a spec (CLI, snapshot): o
 * handler não roda.
 */
export function authOperations(deps?: AuthRoutesDeps): readonly AnyApiOperation[] {
  const { z } = apiLibs();
  const accounts = (): Accounts => {
    if (deps === undefined) throw new Error('auth: rotas só descritas, sem accounts');
    return deps.accounts;
  };
  const d = (): AuthRoutesDeps => {
    accounts();
    return deps as AuthRoutesDeps;
  };
  const role = z.enum(ROLES);
  const user = z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    role,
    status: z.enum(['active', 'disabled']),
    createdAt: z.string(),
    lastLoginAt: z.string().nullable(),
    mustChangePassword: z.boolean(),
    pendingInvite: z.boolean(),
  });
  const invite = z.object({
    token: z.string().meta({ description: 'Mostrado uma única vez; só o hash fica guardado' }),
    expiresAt: z.string(),
  });
  const withInvite = z.object({ user, invite });
  const idParams = z.object({ id: z.string() });
  const manage = { permission: 'users.manage', tags: ['users'] } as const;
  const auth = { tags: ['auth'] } as const;
  const sessionCookie = (request: Request): string | undefined => cookie(request, SESSION_COOKIE);
  const password = z.string().max(1024);

  return [
    {
      method: 'POST',
      path: '/auth/login',
      summary: 'Entra com e-mail e senha; a sessão vai no cookie `bridger_session`',
      ...auth,
      public: true,
      body: z.object({ email: z.string().max(320), password }),
      response: z.object({ user }),
      handler: async ({ body, ip }, request) => {
        try {
          return loggedIn(d(), request, await accounts().login(body.email, body.password, ip));
        } catch (error) {
          if (!(error instanceof TooManyAttempts)) throw error;
          const response = problemResponse(error);
          response.headers.set('retry-after', String(error.retryAfterSeconds));
          return response;
        }
      },
    },
    {
      method: 'POST',
      path: '/auth/logout',
      summary: 'Encerra a sessão atual e apaga o cookie',
      ...auth,
      response: z.object({}),
      handler: async ({ actor }, request) => {
        await accounts().logout(needUser(actor), sessionCookie(request));
        return new Response('{}', {
          headers: {
            'content-type': 'application/json',
            'set-cookie': setCookie(d(), request, '', 0),
          },
        });
      },
    },
    {
      method: 'GET',
      path: '/auth/me',
      summary: 'Quem está autenticado e o que pode',
      ...auth,
      response: z.object({
        id: z.string(),
        kind: z.enum(['user', 'key']),
        name: z.string(),
        role: role.optional(),
        onBehalfOf: z.string().optional(),
        permissions: z.array(z.string()),
      }),
      handler: ({ actor }) => {
        const { id, kind, name, role, permissions, onBehalfOf } = need(actor);
        return {
          id,
          kind,
          name,
          ...(role && { role }),
          ...(onBehalfOf !== undefined && { onBehalfOf }),
          permissions: [...permissions],
        };
      },
    },
    {
      method: 'GET',
      path: '/auth/sessions',
      summary: 'Minhas sessões abertas',
      ...auth,
      response: z.object({
        sessions: z.array(
          z.object({
            id: z.string(),
            createdAt: z.string(),
            lastSeenAt: z.string(),
            expiresAt: z.string(),
            current: z.boolean(),
          }),
        ),
      }),
      handler: async ({ actor }, request) => {
        const token = sessionCookie(request);
        const mine = await accounts().listSessions(needUser(actor).id);
        const current = token === undefined ? undefined : await accounts().currentSession(token);
        return {
          sessions: mine.map(({ id, createdAt, lastSeenAt, expiresAt }) => ({
            id,
            createdAt,
            lastSeenAt,
            expiresAt,
            current: id === current,
          })),
        };
      },
    },
    {
      method: 'DELETE',
      path: '/auth/sessions/:id',
      summary: 'Encerra uma das minhas sessões',
      ...auth,
      params: idParams,
      response: z.object({}),
      handler: async ({ actor, params }) => {
        await accounts().revokeOwnSession(needUser(actor).id, params.id);
        return {};
      },
    },
    {
      method: 'POST',
      path: '/auth/password',
      summary: 'Troca a senha e encerra as outras sessões',
      ...auth,
      body: z.object({ currentPassword: password, newPassword: password }),
      response: z.object({}),
      handler: async ({ actor, body }, request) => {
        await accounts().changePassword(
          needUser(actor),
          body.currentPassword,
          body.newPassword,
          sessionCookie(request),
        );
        return {};
      },
    },
    {
      method: 'POST',
      path: '/auth/invites/accept',
      summary: 'Aceita o convite (ou o token de bootstrap), define a senha e entra',
      ...auth,
      public: true,
      body: z.object({
        token: z.string().max(512),
        password,
        name: z.string().min(1).max(200).optional(),
        email: z.email().max(320).optional(),
      }),
      response: z.object({ user }),
      handler: async ({ body, ip }, request) =>
        loggedIn(d(), request, await accounts().acceptInvite(body, ip)),
    },
    {
      method: 'POST',
      path: '/users',
      summary: 'Cria o usuário e gera o convite',
      ...manage,
      status: 201,
      body: z.object({
        name: z.string().min(1).max(200),
        email: z.email().max(320),
        role,
      }),
      response: withInvite,
      handler: ({ actor, body }) => accounts().createUser(need(actor), body),
    },
    {
      method: 'GET',
      path: '/users',
      summary: 'Lista os usuários',
      ...manage,
      response: z.object({ users: z.array(user) }),
      handler: async () => ({ users: await accounts().listUsers() }),
    },
    {
      method: 'GET',
      path: '/users/:id',
      summary: 'Lê um usuário',
      ...manage,
      params: idParams,
      response: user,
      handler: ({ params }) => accounts().getUser(params.id),
    },
    {
      method: 'PATCH',
      path: '/users/:id',
      summary: 'Altera nome ou papel',
      ...manage,
      params: idParams,
      body: z.object({ name: z.string().min(1).max(200).optional(), role: role.optional() }),
      response: user,
      handler: ({ actor, params, body }) => accounts().updateUser(need(actor), params.id, body),
    },
    {
      method: 'POST',
      path: '/users/:id/disable',
      summary: 'Desativa o usuário e encerra as sessões dele na hora',
      ...manage,
      params: idParams,
      response: user,
      handler: ({ actor, params }) => accounts().setStatus(need(actor), params.id, 'disabled'),
    },
    {
      method: 'POST',
      path: '/users/:id/enable',
      summary: 'Reativa o usuário',
      ...manage,
      params: idParams,
      response: user,
      handler: ({ actor, params }) => accounts().setStatus(need(actor), params.id, 'active'),
    },
    {
      method: 'DELETE',
      path: '/users/:id/sessions',
      summary: 'Encerra todas as sessões do usuário',
      ...manage,
      params: idParams,
      response: z.object({ revoked: z.number().int() }),
      handler: async ({ actor, params }) => ({
        revoked: await accounts().revokeSessions(need(actor), params.id),
      }),
    },
    {
      method: 'POST',
      path: '/users/:id/reset-password',
      summary: 'Zera a senha e gera novo convite',
      ...manage,
      params: idParams,
      response: invite,
      handler: ({ actor, params }) => accounts().resetPassword(need(actor), params.id),
    },
  ];
}
