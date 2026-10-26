// M7-4 parte 2 (ADR 0127): login, sessões, convites, usuários, rate limit, CSRF e recuperação.

import { afterEach, describe, expect, it } from 'vitest';
import { loadApiLibs } from '#api/libs.ts';
import type { ProblemBody } from '#api/problem.ts';
import type { Audit } from '#audit/audit.ts';
import { currentAuditSubject } from '#audit/scope.ts';
import type { InternalRecordInput } from '#audit/types.ts';
import { run as ownerInvite } from '#cli/owner-invite.ts';
import { createHttp, type SessionHttp, sessionHttp } from '#http/server.ts';
import { createNoopLogger } from '#logger/logger.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { kernelStorage } from '#storage/namespace.ts';
import { type Accounts, createAccounts, INVITE_TTL_MS } from './accounts.ts';
import { createActorResolver, SESSION_COOKIE } from './actor.ts';
import { createApiGuard } from './guard.ts';
import { createLoginLimiter } from './rate-limit.ts';
import { createAuthStore } from './store.ts';
import type { ApiActor } from './types.ts';

const HOUR = 3_600_000;
const T0 = new Date('2026-10-26T12:00:00Z');
const PASSWORD = 'uma senha bem longa';

function setup(options: { bootstrapToken?: string; maxAgeMs?: number; realClock?: boolean } = {}) {
  const storage = kernelStorage(createMemoryStorage(), 'auth');
  const store = createAuthStore(storage);
  const clock = { now: T0 };
  // O servidor HTTP resolve a sessão com o relógio real: sessão criada em T0 já estaria inativa.
  const now = () => (options.realClock ? new Date() : clock.now);
  const recorded: InternalRecordInput[] = [];
  const audit = { record: (e: InternalRecordInput) => recorded.push(e) } as unknown as Audit;
  const accounts = createAccounts({
    storage,
    store,
    audit: () => audit,
    now,
    sessionMaxAgeMs: options.maxAgeMs ?? 7 * 24 * HOUR,
    ...(options.bootstrapToken && { bootstrapToken: options.bootstrapToken }),
    limiter: createLoginLimiter({ now }),
  });
  return { storage, store, clock, now, recorded, accounts };
}

const actor = (role: 'owner' | 'admin', id = 'a1'): ApiActor => ({
  id,
  kind: 'user',
  name: 'Quem',
  role,
  permissions: [],
});

/** Cria o usuário, aceita o convite com a senha e devolve o id e o token da sessão. */
async function activate(
  accounts: Accounts,
  by: ApiActor,
  role: 'owner' | 'admin' | 'viewer',
  email: string,
) {
  const { user, invite } = await accounts.createUser(by, { name: email, email, role });
  const login = await accounts.acceptInvite({ token: invite.token, password: PASSWORD });
  return { id: user.id, token: login.token };
}

async function status(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { status?: number }).status;
  }
}

describe('login', () => {
  it('senha certa abre sessão; errada, e-mail inexistente e conta desativada dão a mesma falha', async () => {
    const { accounts, store, now } = setup();
    const admin = actor('owner');
    const { id } = await activate(accounts, admin, 'admin', 'ana@exemplo.com');
    const ok = await accounts.login('ANA@exemplo.com', PASSWORD, '1.1.1.1');
    expect(ok.user).toMatchObject({ email: 'ana@exemplo.com', role: 'admin' });
    expect(ok.user).not.toHaveProperty('passwordHash');
    const resolve = createActorResolver({ store, now });
    expect(
      await resolve(
        new Request('http://x/', { headers: { cookie: `${SESSION_COOKIE}=${ok.token}` } }),
      ),
    ).toMatchObject({ id });

    const messages = new Set<string>();
    for (const [email, password] of [
      ['ana@exemplo.com', 'senha errada mesmo'],
      ['ninguem@exemplo.com', PASSWORD],
    ] as const) {
      try {
        await accounts.login(email, password, '2.2.2.2');
      } catch (error) {
        messages.add(`${(error as { status: number }).status} ${(error as Error).message}`);
      }
    }
    await accounts.setStatus(admin, id, 'disabled');
    try {
      await accounts.login('ana@exemplo.com', PASSWORD, '3.3.3.3');
    } catch (error) {
      messages.add(`${(error as { status: number }).status} ${(error as Error).message}`);
    }
    expect([...messages]).toEqual(['401 e-mail ou senha inválidos']);
  });

  it('usuário com convite pendente não entra', async () => {
    const { accounts } = setup();
    await accounts.createUser(actor('owner'), { name: 'B', email: 'b@x.com', role: 'viewer' });
    expect(await status(accounts.login('b@x.com', '', undefined))).toBe(401);
  });

  it('5 falhas bloqueiam com 429 (mesmo com a senha certa) e a espera dobra', async () => {
    const { accounts, clock } = setup();
    await activate(accounts, actor('owner'), 'viewer', 'c@x.com');
    for (let i = 0; i < 5; i++) {
      expect(await status(accounts.login('c@x.com', 'errada errada', '9.9.9.9'))).toBe(401);
    }
    expect(await status(accounts.login('c@x.com', PASSWORD, '9.9.9.9'))).toBe(429);
    // Outro IP, mesmo e-mail: o limite por e-mail também vale.
    expect(await status(accounts.login('c@x.com', PASSWORD, '8.8.8.8'))).toBe(429);
    // Mesmo IP, outro e-mail: o limite por IP vale.
    expect(await status(accounts.login('d@x.com', PASSWORD, '9.9.9.9'))).toBe(429);

    clock.now = new Date(clock.now.getTime() + 31_000);
    // Liberou (30 s); a falha seguinte bloqueia por 60 s.
    expect(await status(accounts.login('c@x.com', 'errada errada', '9.9.9.9'))).toBe(401);
    clock.now = new Date(clock.now.getTime() + 31_000);
    expect(await status(accounts.login('c@x.com', PASSWORD, '9.9.9.9'))).toBe(429);
    clock.now = new Date(clock.now.getTime() + 30_000);
    expect((await accounts.login('c@x.com', PASSWORD, '9.9.9.9')).user.email).toBe('c@x.com');
  });
});

describe('sessões', () => {
  it('expira por inatividade e no limite absoluto', async () => {
    const { accounts, store, clock, now } = setup({ maxAgeMs: 10 * HOUR });
    await activate(accounts, actor('owner'), 'viewer', 'e@x.com');
    const { token } = await accounts.login('e@x.com', PASSWORD, undefined);
    const resolve = createActorResolver({ store, now, idleMs: 8 * HOUR });
    const req = () =>
      new Request('http://x/', { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    clock.now = new Date(T0.getTime() + 7 * HOUR);
    expect(await resolve(req())).toBeDefined();
    clock.now = new Date(T0.getTime() + 9.5 * HOUR);
    expect(await resolve(req())).toBeDefined();
    // 10 h depois do login: o limite absoluto vence mesmo com uso contínuo.
    clock.now = new Date(T0.getTime() + 10 * HOUR);
    expect(await resolve(req())).toBeUndefined();
  });

  it('desativar revoga as sessões na hora; encerrar sessões também', async () => {
    const { accounts, store, now } = setup();
    const owner = actor('owner');
    const { id, token } = await activate(accounts, owner, 'viewer', 'f@x.com');
    const resolve = createActorResolver({ store, now });
    const req = new Request('http://x/', { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(await resolve(req)).toBeDefined();
    await accounts.setStatus(owner, id, 'disabled');
    expect(await resolve(req)).toBeUndefined();
    expect((await store.findSessionByToken(token))?.revokedAt).toBeDefined();

    await accounts.setStatus(owner, id, 'active');
    const again = await accounts.login('f@x.com', PASSWORD, undefined);
    expect(await accounts.revokeSessions(owner, id)).toBe(1);
    expect((await store.findSessionByToken(again.token))?.revokedAt).toBeDefined();
  });

  it('troca de senha encerra as outras sessões e mantém a atual', async () => {
    const { accounts, store } = setup();
    const { id, token: first } = await activate(accounts, actor('owner'), 'viewer', 'g@x.com');
    const second = await accounts.login('g@x.com', PASSWORD, undefined);
    const me = { ...actor('admin', id), role: 'viewer' as const };
    expect(
      await status(accounts.changePassword(me, 'errada errada', 'outra senha longa', undefined)),
    ).toBe(403);
    expect(await status(accounts.changePassword(me, PASSWORD, 'curta', undefined))).toBe(400);
    await accounts.changePassword(me, PASSWORD, 'outra senha longa', second.token);
    expect((await store.findSessionByToken(first))?.revokedAt).toBeDefined();
    expect((await store.findSessionByToken(second.token))?.revokedAt).toBeUndefined();
    expect(await status(accounts.login('g@x.com', PASSWORD, undefined))).toBe(401);
    expect((await accounts.login('g@x.com', 'outra senha longa', undefined)).token).toBeDefined();
  });

  it('lista só as minhas sessões abertas e encerra uma delas', async () => {
    const { accounts } = setup();
    const owner = actor('owner');
    const a = await activate(accounts, owner, 'viewer', 'h@x.com');
    const b = await activate(accounts, owner, 'viewer', 'i@x.com');
    const second = await accounts.login('h@x.com', PASSWORD, undefined);
    const mine = await accounts.listSessions(a.id);
    expect(mine).toHaveLength(2);
    expect(await accounts.currentSession(second.token)).toBe(mine[1]?.id);
    const [victim] = await accounts.listSessions(b.id);
    expect(await status(accounts.revokeOwnSession(a.id, victim?.id ?? ''))).toBe(404);
    await accounts.revokeOwnSession(a.id, mine[0]?.id ?? '');
    expect(await accounts.listSessions(a.id)).toHaveLength(1);
  });
});

describe('convites', () => {
  it('uso único, guardado só como hash, e vale 48 h', async () => {
    const { accounts, clock, storage } = setup();
    const owner = actor('owner');
    const { invite } = await accounts.createUser(owner, {
      name: 'J',
      email: 'j@x.com',
      role: 'viewer',
    });
    expect(Date.parse(invite.expiresAt) - T0.getTime()).toBe(INVITE_TTL_MS);
    const stored = JSON.stringify(await storage.collection('invites').find());
    expect(stored).not.toContain(invite.token);
    await accounts.acceptInvite({ token: invite.token, password: PASSWORD });
    expect(await status(accounts.acceptInvite({ token: invite.token, password: PASSWORD }))).toBe(
      400,
    );

    const late = await accounts.createUser(owner, { name: 'K', email: 'k@x.com', role: 'viewer' });
    clock.now = new Date(T0.getTime() + INVITE_TTL_MS);
    expect(
      await status(accounts.acceptInvite({ token: late.invite.token, password: PASSWORD })),
    ).toBe(400);
  });

  it('senha fraca não consome o convite; reset invalida o convite e a senha antiga', async () => {
    const { accounts } = setup();
    const owner = actor('owner');
    const { user, invite } = await accounts.createUser(owner, {
      name: 'L',
      email: 'l@x.com',
      role: 'viewer',
    });
    expect(await status(accounts.acceptInvite({ token: invite.token, password: 'curta' }))).toBe(
      400,
    );
    await accounts.acceptInvite({ token: invite.token, password: PASSWORD });

    const fresh = await accounts.resetPassword(owner, user.id);
    expect(await status(accounts.login('l@x.com', PASSWORD, undefined))).toBe(401);
    const second = await accounts.resetPassword(owner, user.id);
    expect(await status(accounts.acceptInvite({ token: fresh.token, password: PASSWORD }))).toBe(
      400,
    );
    expect(
      (await accounts.acceptInvite({ token: second.token, password: PASSWORD })).user.email,
    ).toBe('l@x.com');
  });
});

describe('bootstrap e recuperação', () => {
  const BOOT = 'token-de-bootstrap-1234';

  it('o token da config cria o primeiro owner e depois não vale mais', async () => {
    const { accounts, store } = setup({ bootstrapToken: BOOT });
    const first = { token: BOOT, password: PASSWORD, name: 'Dono', email: 'dono@x.com' };
    expect(await status(accounts.acceptInvite({ ...first, token: 'errado-errado-errado' }))).toBe(
      400,
    );
    expect(await status(accounts.acceptInvite({ token: BOOT, password: PASSWORD }))).toBe(400);
    const done = await accounts.acceptInvite(first);
    expect(done.user.role).toBe('owner');
    expect((await store.findUserByEmail('dono@x.com'))?.role).toBe('owner');
    expect(await status(accounts.acceptInvite({ ...first, email: 'outro@x.com' }))).toBe(400);
  });

  it('recuperação: recusa com owner ativo; sem ele, cria ou promove e gera convite', async () => {
    const { accounts, store } = setup();
    const owner = actor('owner');
    const sole = await activate(accounts, owner, 'owner', 'o@x.com');
    expect(await status(accounts.recoverOwner({ email: 'o@x.com' }))).toBe(409);

    // O último owner não pode ser desativado pela API; força o estado como se tivesse sumido.
    await store.updateUser(sole.id, { status: 'disabled' });
    expect(await status(accounts.recoverOwner({ email: 'novo@x.com' }))).toBe(400);
    const invite = await accounts.recoverOwner({ email: 'novo@x.com', name: 'Novo' });
    const login = await accounts.acceptInvite({ token: invite.token, password: PASSWORD });
    expect(login.user).toMatchObject({ role: 'owner', status: 'active' });

    await store.updateUser(login.user.id, { status: 'disabled' });
    const back = await accounts.recoverOwner({ email: 'o@x.com' });
    await accounts.acceptInvite({ token: back.token, password: PASSWORD });
    expect((await store.getUser(sole.id))?.status).toBe('active');
  });

  it('o comando `bridger owner-invite` imprime o convite no storage do app', async () => {
    const storage = createMemoryStorage();
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
    const load = async () => ({ storage });
    expect(await ownerInvite(['app.ts', '--email', 'r@x.com'], io, load)).toBe(1);
    expect(err.join()).toContain('--name');
    expect(
      await ownerInvite(['app.ts', '--email', 'r@x.com', '--name', 'R'], io, async () => ({
        storage: createMemoryStorage(),
      })),
    ).toBe(0);
    expect(out[0]).toMatch(/bri_/);
  });
});

describe('papéis e último owner', () => {
  it('admin não cria, altera, desativa nem reseta owner; owner pode', async () => {
    const { accounts } = setup();
    const owner = actor('owner');
    const admin = actor('admin');
    const o2 = await activate(accounts, owner, 'owner', 'o2@x.com');
    await activate(accounts, owner, 'owner', 'o3@x.com');
    expect(
      await status(accounts.createUser(admin, { name: 'x', email: 'x@x.com', role: 'owner' })),
    ).toBe(403);
    expect(await status(accounts.updateUser(admin, o2.id, { name: 'novo' }))).toBe(403);
    expect(await status(accounts.setStatus(admin, o2.id, 'disabled'))).toBe(403);
    expect(await status(accounts.resetPassword(admin, o2.id))).toBe(403);
    expect(await status(accounts.revokeSessions(admin, o2.id))).toBe(403);
    const v = await activate(accounts, admin, 'viewer', 'v@x.com');
    expect(await status(accounts.updateUser(admin, v.id, { role: 'owner' }))).toBe(403);
    expect((await accounts.updateUser(admin, v.id, { role: 'admin' })).role).toBe('admin');
    expect((await accounts.setStatus(owner, o2.id, 'disabled')).status).toBe('disabled');
  });

  it('o último owner ativo não é desativado nem rebaixado', async () => {
    const { accounts } = setup();
    const owner = actor('owner');
    const a = await activate(accounts, owner, 'owner', 'a@x.com');
    expect(await status(accounts.setStatus(owner, a.id, 'disabled'))).toBe(409);
    expect(await status(accounts.updateUser(owner, a.id, { role: 'admin' }))).toBe(409);
    const b = await activate(accounts, owner, 'owner', 'b@x.com');
    expect((await accounts.updateUser(owner, a.id, { role: 'admin' })).role).toBe('admin');
    expect(await status(accounts.setStatus(owner, b.id, 'disabled'))).toBe(409);
  });

  it('e-mail repetido dá 409', async () => {
    const { accounts } = setup();
    const owner = actor('owner');
    await accounts.createUser(owner, { name: 'a', email: 'dup@x.com', role: 'viewer' });
    expect(
      await status(accounts.createUser(owner, { name: 'b', email: 'DUP@x.com', role: 'viewer' })),
    ).toBe(409);
  });
});

describe('auditoria', () => {
  it('registra login, falha, convite, usuário e sessões com o ator', async () => {
    const { accounts, recorded } = setup();
    const owner = actor('owner', 'o1');
    const { id } = await activate(accounts, owner, 'viewer', 'z@x.com');
    await accounts.login('z@x.com', 'errada errada', '4.4.4.4').catch(() => undefined);
    const session = await accounts.login('z@x.com', PASSWORD, undefined);
    await accounts.logout({ ...owner, id }, session.token);
    await accounts.updateUser(owner, id, { name: 'Zé' });
    await accounts.revokeSessions(owner, id);
    await accounts.setStatus(owner, id, 'disabled');
    await accounts.setStatus(owner, id, 'active');
    const actions = recorded.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'kernel.user.created',
        'kernel.auth.invite.created',
        'kernel.auth.invite.accepted',
        'kernel.auth.login.failed',
        'kernel.auth.login',
        'kernel.auth.logout',
        'kernel.user.updated',
        'kernel.auth.sessions.revoked',
        'kernel.user.disabled',
        'kernel.user.enabled',
      ]),
    );
    const failed = recorded.find((e) => e.action === 'kernel.auth.login.failed');
    expect(failed).toMatchObject({
      outcome: 'denied',
      target: { type: 'user', id },
      ip: '4.4.4.4',
    });
    expect(recorded.find((e) => e.action === 'kernel.auth.login')?.actor).toMatchObject({ id });
    expect(JSON.stringify(recorded)).not.toContain('passwordHash');
  });
});

describe('HTTP: cookie e CSRF', () => {
  const attached: SessionHttp[] = [];
  afterEach(async () => {
    for (const session of attached.splice(0)) await session.detach();
  });

  let last: { store: ReturnType<typeof createAuthStore>; recorded: InternalRecordInput[] };

  async function start(origins?: string[], sessionName = 'default') {
    await loadApiLibs();
    const { store, accounts, recorded } = setup({
      bootstrapToken: 'token-de-bootstrap-1234',
      realClock: true,
    });
    last = { store, recorded };
    const guard = createApiGuard({
      store,
      audit: () => ({ record: (e: InternalRecordInput) => recorded.push(e) }) as unknown as Audit,
      accounts,
      sessionMaxAgeMs: 7 * 24 * HOUR,
    });
    const http = createHttp({ port: 0, hostname: '127.0.0.1' });
    const session = sessionHttp(
      http,
      sessionName,
      createNoopLogger,
      undefined,
      origins ? { cors: { origins } } : {},
      guard,
    );
    // As rotas do core não abrem a porta sozinhas: uma rota qualquer de plugin a abre.
    session
      .scope(
        'demo',
        () => '/plugins/demo',
        (error) => {
          throw error;
        },
      )
      .route('GET', '/ping', () => new Response('ok'));
    session.attach(() => 'running');
    attached.push(session);
    await session.listen();
    const prefix = sessionName === 'default' ? '' : `/sessions/${sessionName}`;
    return `http://127.0.0.1:${http.port}${prefix}/api`;
  }

  const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const boot = {
    token: 'token-de-bootstrap-1234',
    password: PASSWORD,
    name: 'Dono',
    email: 'd@x.com',
  };

  it('mesma origem: cookie HttpOnly; Secure; SameSite=Strict e /me com ele', async () => {
    const base = await start();
    const res = await fetch(`${base}/auth/invites/accept`, json(boot));
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^bridger_session=brs_/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    const me = await fetch(`${base}/auth/me`, { headers: { cookie: cookie.split(';')[0] ?? '' } });
    expect(await me.json()).toMatchObject({ kind: 'user', role: 'owner' });
    expect((await fetch(`${base}/auth/me`)).status).toBe(401);
    expect((await fetch(`${base}/users`)).status).toBe(401);

    const bad = await fetch(
      `${base}/auth/login`,
      json({ email: 'd@x.com', password: 'errada errada' }),
    );
    expect(bad.status).toBe(401);
    const login = await fetch(`${base}/auth/login`, json({ email: 'd@x.com', password: PASSWORD }));
    expect(login.status).toBe(200);
    const out = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: { cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '' },
    });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('429 traz Retry-After', async () => {
    const base = await start();
    for (let i = 0; i < 5; i++) {
      await fetch(`${base}/auth/login`, json({ email: 'q@x.com', password: 'errada errada' }));
    }
    const res = await fetch(
      `${base}/auth/login`,
      json({ email: 'q@x.com', password: 'errada errada' }),
    );
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(((await res.json()) as ProblemBody).status).toBe(429);
  });

  it('origem permitida: cookie SameSite=None e escrita sem X-Bridger-CSRF dá 403', async () => {
    const origin = 'https://painel.exemplo.com';
    const base = await start([origin]);
    const noHeader = await fetch(`${base}/auth/invites/accept`, json(boot, { origin }));
    expect(noHeader.status).toBe(403);
    expect(noHeader.headers.get('access-control-allow-origin')).toBe(origin);
    expect(((await noHeader.json()) as ProblemBody).detail).toContain('x-bridger-csrf');

    const ok = await fetch(
      `${base}/auth/invites/accept`,
      json(boot, { origin, 'x-bridger-csrf': '1' }),
    );
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('SameSite=None');
    expect(cookie).toContain('Secure');
    // Leitura não exige o header; escrita sem Origin (servidor a servidor) também não.
    const me = await fetch(`${base}/auth/me`, {
      headers: { origin, cookie: cookie.split(';')[0] ?? '' },
    });
    expect(me.status).toBe(200);
  });

  it('rotas de usuário exigem users.manage: viewer leva 403', async () => {
    const base = await start();
    const res = await fetch(`${base}/auth/invites/accept`, json(boot));
    const owner = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const created = await fetch(
      `${base}/users`,
      json({ name: 'V', email: 'v@x.com', role: 'viewer' }, { cookie: owner }),
    );
    expect(created.status).toBe(201);
    const { invite } = (await created.json()) as { invite: { token: string } };
    const accepted = await fetch(
      `${base}/auth/invites/accept`,
      json({ token: invite.token, password: PASSWORD }),
    );
    const viewer = (accepted.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect((await fetch(`${base}/users`, { headers: { cookie: viewer } })).status).toBe(403);
    const list = await fetch(`${base}/users`, { headers: { cookie: owner } });
    expect(((await list.json()) as { users: unknown[] }).users).toHaveLength(2);
  });

  it('cookie por sessão do servidor: Path=<prefixo>/api', async () => {
    const base = await start(undefined, 'erp');
    const res = await fetch(`${base}/auth/invites/accept`, json(boot));
    expect(res.headers.get('set-cookie')).toContain('Path=/sessions/erp/api;');
    expect(
      (
        await fetch(`${base}/auth/me`, {
          headers: { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '' },
        })
      ).status,
    ).toBe(200);
  });

  it('API key não usa as rotas de conta (403) e e-mail inválido dá 400', async () => {
    const base = await start();
    const owner =
      (
        (await fetch(`${base}/auth/invites/accept`, json(boot))).headers.get('set-cookie') ?? ''
      ).split(';')[0] ?? '';
    const key = await last.store.createApiKey(
      { name: 'k', permissions: ['users.manage'] },
      new Date(),
    );
    const bearer = { authorization: `Bearer ${key.secret}` };
    for (const path of ['/auth/sessions']) {
      expect((await fetch(`${base}${path}`, { headers: bearer })).status).toBe(403);
    }
    expect((await fetch(`${base}/auth/logout`, { method: 'POST', headers: bearer })).status).toBe(
      403,
    );
    expect((await fetch(`${base}/auth/me`, { headers: bearer })).status).toBe(200);
    const bad = await fetch(
      `${base}/users`,
      json({ name: 'V', email: 'nao-e-email', role: 'viewer' }, { cookie: owner }),
    );
    expect(bad.status).toBe(400);
  });

  it('CSRF recusado é auditado como kernel.auth.denied com o ator; invite aceito por IP é limitado', async () => {
    const origin = 'https://painel.exemplo.com';
    const base = await start([origin]);
    const ok = await fetch(
      `${base}/auth/invites/accept`,
      json(boot, { origin, 'x-bridger-csrf': '1' }),
    );
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const res = await fetch(`${base}/auth/logout`, json({}, { origin, cookie }));
    expect(res.status).toBe(403);
    expect(last.recorded.find((e) => e.action === 'kernel.auth.denied')).toMatchObject({
      outcome: 'denied',
      details: { reason: 'csrf' },
    });
    for (let i = 0; i < 5; i++) {
      const r = await fetch(
        `${base}/auth/invites/accept`,
        json({ token: `chute-${i}`, password: PASSWORD }, { origin, 'x-bridger-csrf': '1' }),
      );
      expect(r.status).toBe(400);
    }
    const blocked = await fetch(
      `${base}/auth/invites/accept`,
      json({ token: 'outro', password: PASSWORD }, { origin, 'x-bridger-csrf': '1' }),
    );
    expect(blocked.status).toBe(429);
  });
});

describe('concorrência, proxy e papéis', () => {
  it('logins paralelos com senha errada: só 5 chegam a verificar', async () => {
    const { accounts } = setup();
    await activate(accounts, actor('owner'), 'viewer', 'p@x.com');
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        status(accounts.login('p@x.com', 'errada errada', '7.7.7.7')),
      ),
    );
    // O teto de scrypt (4 ao mesmo tempo) devolve a reserva do excedente; nunca passa de 5 verificações.
    expect(results.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(results.filter((s) => s === 401).length).toBeGreaterThan(0);
    expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(15);
  });

  it('teto global de scrypt: rajada de IPs e e-mails distintos leva 429 no excedente', async () => {
    const { accounts } = setup();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        status(accounts.login(`u${i}@x.com`, 'qualquer coisa', `10.0.0.${i}`)),
      ),
    );
    expect(results.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(results.filter((s) => s === 401).length).toBeGreaterThan(0);
  });

  it('convite com token inválido não gasta scrypt: a mensagem é a do convite, não a da senha', async () => {
    const { accounts } = setup();
    const error = await accounts
      .acceptInvite({ token: 'nada', password: 'curta' })
      .catch((e: Error) => e);
    expect((error as Error).message).toBe('convite inválido ou expirado');
  });

  it('troca de senha: erro é 403 e 5 erros bloqueiam o usuário (429)', async () => {
    const { accounts } = setup();
    const { id } = await activate(accounts, actor('owner'), 'viewer', 'w@x.com');
    const me = { ...actor('admin', id), role: 'viewer' as const };
    for (let i = 0; i < 5; i++) {
      expect(
        await status(accounts.changePassword(me, 'errada errada', 'outra senha longa', undefined)),
      ).toBe(403);
    }
    expect(
      await status(accounts.changePassword(me, PASSWORD, 'outra senha longa', undefined)),
    ).toBe(429);
  });

  it('trustProxy: IP do X-Forwarded-For pelo número de saltos; padrão é o socket; vai no titular da auditoria', async () => {
    const { store } = setup();
    const audit = { record: () => undefined } as unknown as Audit;
    const req = new Request('http://x/', {
      headers: { 'x-forwarded-for': 'forjado, 1.2.3.4, 5.6.7.8' },
    });
    expect(createApiGuard({ store, audit: () => audit }).clientIp(req, '9.9.9.9')).toBe('9.9.9.9');
    expect(
      createApiGuard({ store, audit: () => audit, trustProxy: 1 }).clientIp(req, '9.9.9.9'),
    ).toBe('5.6.7.8');
    expect(
      createApiGuard({ store, audit: () => audit, trustProxy: 2 }).clientIp(req, '9.9.9.9'),
    ).toBe('1.2.3.4');
    expect(
      createApiGuard({ store, audit: () => audit, trustProxy: 9 }).clientIp(req, '9.9.9.9'),
    ).toBe('9.9.9.9');
    const seen = createApiGuard({ store, audit: () => audit }).run(
      actor('owner'),
      req,
      () => currentAuditSubject()?.ip,
      '1.1.1.1',
    );
    expect(seen).toBe('1.1.1.1');
  });

  it('admin tentando gerir owner é auditado como kernel.auth.denied', async () => {
    const { accounts, recorded } = setup();
    const { id } = await activate(accounts, actor('owner'), 'owner', 'ow@x.com');
    await accounts.setStatus(actor('admin'), id, 'disabled').catch(() => undefined);
    expect(recorded.find((e) => e.action === 'kernel.auth.denied')).toMatchObject({
      outcome: 'denied',
      target: { type: 'user', id },
      details: { reason: 'role' },
    });
  });
});
