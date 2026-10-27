// Servidor HTTP do processo (ADR 0018, 0072). Um por processo, dividido pelos bots como o
// storage: cada bot publica a própria tabela de rotas (`SessionHttp`) ao subir e a retira ao
// parar. O router do Hono não remove rota, então o app é remontado da tabela a cada mudança,
// que só acontece no boot, no reload e no stop. Hono, adapter do Node e `ws` carregam só ao
// abrir a porta: bot sem rota não paga a memória deles.

import type { Server } from 'node:http';
import { BlockList, isIP } from 'node:net';
import type { upgradeWebSocket as UpgradeWebSocket } from '@hono/node-server';
import type { Context, Hono } from 'hono';
import type { WSContext, WSEvents } from 'hono/ws';
import type { WebSocketServer } from 'ws';
import type { ConnectionApiDeps } from '#api/connection.ts';
import { coreApiOperations } from '#api/core.ts';
import {
  type ApiOptions,
  corsMiddleware,
  csrfMiddleware,
  socketAddress,
  validateApiOptions,
} from '#api/cors.ts';
import type { EventStream } from '#api/events.ts';
import { loadApiLibs } from '#api/libs.ts';
import { createOpenApiDocument } from '#api/openapi.ts';
import { type AnyApiOperation, operationHandler } from '#api/operation.ts';
import { ApiError, problemResponse } from '#api/problem.ts';
import type { ApiGuard } from '#auth/guard.ts';
import { BotConfigError } from '#config/owners.ts';
import * as LOG from '#logger/events.ts';
import { NO_TRAIL, type Trail } from '#logger/trail.ts';
import type { Logger } from '#logger/types.ts';
import { DEFAULT_SESSION } from '#storage/namespace.ts';
import {
  formatTraceparent,
  newTraceId,
  parseTraceFlags,
  parseTraceparent,
  runInTrace,
} from '#trace/scope.ts';
import type {
  HttpHandler,
  HttpMethod,
  HttpOptions,
  HttpRequestInfo,
  HttpServer,
  HttpSocket,
  HttpSocketAccept,
  HttpSocketHandlers,
  PluginHttpRoutes,
} from './types.ts';

const METHODS: ReadonlySet<string> = new Set<HttpMethod>([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

/** Código de fechamento "going away": a rota sumiu (reload, teardown ou stop). */
const GOING_AWAY = 1001;

/** O mesmo método e caminho registrados duas vezes pelo mesmo dono. */
export class HttpRouteConflictError extends Error {
  override readonly name = 'HttpRouteConflictError';
  readonly method: HttpMethod;
  readonly path: string;

  constructor(method: HttpMethod, path: string) {
    super(`rota ${method} ${path} já registrada`);
    this.method = method;
    this.path = path;
  }
}

/** Módulos do servidor, carregados na primeira abertura da porta. */
interface ServerLib {
  readonly Hono: typeof Hono;
  readonly upgradeWebSocket: typeof UpgradeWebSocket;
}

interface RouteEntry {
  readonly owner: string;
  readonly method: HttpMethod;
  /** Caminho relativo, normalizado (sem barra final). */
  readonly path: string;
  /** Resolvido ao montar o app: o nome do transport só existe depois da fábrica. */
  readonly base: () => string;
  readonly target: HttpHandler | { readonly ws: HttpSocketAccept };
  readonly onError: (error: unknown) => void;
  /** Presente nas operações da API (ADR 0125): alimenta a spec. */
  readonly api?: AnyApiOperation;
  /** Trilha do bot dono da rota (ADR 0120). */
  readonly trail: Trail;
  /** Conexões abertas, fechadas quando a rota sai. */
  readonly sockets: Set<WSContext>;
}

// O `HttpServer` público só expõe a porta; o resto é do kernel.
const hubs = new WeakMap<HttpServer, HttpHub>();

/**
 * Servidor HTTP para `BotConfig.http`, o mesmo para todos os bots do processo. Nada abre aqui:
 * a porta abre no `start()` do primeiro bot que tiver rota (ver docs/http.md).
 */
export function createHttp(options: HttpOptions): HttpServer {
  const { port } = options;
  if (!(Number.isInteger(port) && port >= 0 && port <= 65_535)) {
    throw new RangeError(`http: port deve ser inteiro entre 0 e 65535 (recebido: ${port})`);
  }
  const hub = new HttpHub(options);
  const server: HttpServer = {
    get port() {
      return hub.port;
    },
  };
  hubs.set(server, hub);
  return server;
}

const PERMISSION_FORMAT = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

/** Tabela de rotas de uma sessão nesse servidor; sem efeito até o `attach`. */
export function sessionHttp(
  server: HttpServer,
  session: string,
  log: () => Logger,
  trail: Trail = NO_TRAIL,
  api: ApiOptions = {},
  guard?: ApiGuard,
): SessionHttp {
  const hub = hubs.get(server);
  if (hub === undefined) {
    throw new BotConfigError('http: passe o servidor criado por `createHttp({ port })`');
  }
  validateApiOptions(api);
  // Cedo, no config: sem auth a API só pode escutar em loopback (ADR 0128).
  if (guard === undefined && !isLoopbackHost(hub.hostname)) {
    throw new BotConfigError(
      `http: a API não pode escutar em ${hub.hostname ?? 'todas as interfaces'} sem autenticação; ` +
        'configure `api.auth` ou use `createHttp({ port, hostname: "127.0.0.1" })` (loopback)',
    );
  }
  return new SessionHttp(hub, session, log, trail, api.cors?.origins, guard);
}

/** Loopback: 127.0.0.0/8, `::1` ou `localhost`. Hostname ausente escuta em todas as interfaces. */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

function isLoopbackHost(hostname: string | undefined): boolean {
  if (hostname === undefined) return false;
  const host = hostname.toLowerCase();
  const family = isIP(host);
  return (
    host === 'localhost' || (family !== 0 && LOOPBACK.check(host, family === 6 ? 'ipv6' : 'ipv4'))
  );
}

/** Prefixo das rotas da sessão: nenhum na `default`, para a URL não mudar quando entra outro bot. */
function sessionPrefix(session: string): string {
  return session === DEFAULT_SESSION ? '' : `/sessions/${session}`;
}

function normalizePath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new TypeError(`http: o caminho deve começar com "/" (recebido: ${String(path)})`);
  }
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** Rotas de um bot no servidor. Publicadas no `attach` (start) e retiradas no `detach` (stop). */
export class SessionHttp {
  readonly session: string;
  readonly log: () => Logger;
  readonly #hub: HttpHub;
  readonly #prefix: string;
  readonly #entries = new Map<string, RouteEntry>();
  readonly #trail: Trail;
  readonly #guard: ApiGuard | undefined;
  #state: () => string = () => 'idle';
  #realtime: { readonly connection: ConnectionApiDeps; readonly stream: EventStream } | undefined;
  #attached = false;

  /** Origens CORS permitidas na API desta sessão; `undefined` desliga o CORS. */
  readonly corsOrigins: readonly string[] | undefined;

  constructor(
    hub: HttpHub,
    session: string,
    log: () => Logger,
    trail: Trail,
    corsOrigins?: readonly string[],
    guard?: ApiGuard,
  ) {
    this.corsOrigins = corsOrigins;
    this.#guard = guard;
    this.#hub = hub;
    this.session = session;
    this.log = log;
    this.#trail = trail;
    this.#prefix = sessionPrefix(session);
  }

  /**
   * Rotas de um dono (um plugin, ou o transport) sob `prefixo + segment()`. `onError` recebe a
   * falha de um handler com a rota (`POST /webhook`).
   */
  scope(
    owner: string,
    segment: () => string,
    onError: (error: unknown, route: string) => void,
  ): PluginHttpRoutes {
    const base = (): string => this.#prefix + segment();
    // A API vive sob `<sessão>/api`, e a rota do plugin sob o segmento dele (ADR 0125).
    const apiBase = (): string => `${this.#prefix}/api${segment()}`;
    const guard = this.#guard;
    const add = (
      method: HttpMethod,
      rawPath: string,
      target: RouteEntry['target'],
      api?: AnyApiOperation,
    ): void => {
      const path = normalizePath(rawPath);
      const key = `${owner} ${api ? 'api ' : ''}${method} ${path}`;
      if (this.#entries.has(key)) throw new HttpRouteConflictError(method, path);
      this.#entries.set(key, {
        owner,
        method,
        path,
        base: api ? apiBase : base,
        ...(api && { api }),
        target,
        onError: (error) => onError(error, `${method} ${path}`),
        trail: this.#trail,
        sockets: new Set(),
      });
      if (this.#attached) this.#hub.changed();
    };
    return {
      get basePath() {
        return base();
      },
      route(method, path, handler) {
        if (!METHODS.has(method)) {
          throw new TypeError(`http: método não suportado: ${String(method)}`);
        }
        add(method, path, handler);
      },
      ws(path, accept) {
        add('GET', path, { ws: accept });
      },
      api(operation) {
        if (!METHODS.has(operation.method)) {
          throw new TypeError(`http: método não suportado: ${String(operation.method)}`);
        }
        // Falha no registro: permissão fora do formato nunca casaria, e a rota daria 403 para todos.
        if (operation.permission !== undefined && !PERMISSION_FORMAT.test(operation.permission)) {
          throw new BotConfigError(
            `http: permissão "${operation.permission}" de ${operation.method} ${operation.path} fora do formato <área>.<ação> (ex.: "logs.read")`,
          );
        }
        add(
          operation.method,
          operation.path,
          operationHandler(
            operation,
            (error) => onError(error, `${operation.method} ${operation.path}`),
            guard,
          ),
          operation,
        );
      },
    };
  }

  /** Operações do core nesta sessão (`/api/...`); não contam como rota para abrir a porta. */
  coreEntries(states: () => Record<string, string>): RouteEntry[] {
    const base = (): string => `${this.#prefix}/api`;
    const onError = (error: unknown): void => this.log().event(LOG.httpUnhandled, { err: error });
    const guard = this.#guard;
    const { accounts, sessionMaxAgeMs } = guard ?? {};
    const auth =
      guard && accounts && sessionMaxAgeMs !== undefined
        ? {
            accounts,
            sessionMaxAgeMs,
            corsOrigins: this.corsOrigins,
            // Um cookie por sessão do servidor: bots em /sessions/<nome> não sobrescrevem o do outro.
            cookiePath: `${this.#prefix}/api`,
            keys: guard.keys,
            denied: guard.denied,
          }
        : undefined;
    return coreApiOperations(states, auth, this.#realtime).map((api) => ({
      owner: 'core',
      method: api.method,
      path: normalizePath(api.path),
      base,
      api,
      target: operationHandler(api, onError, this.#guard),
      onError,
      trail: this.#trail,
      sockets: new Set(),
    }));
  }

  get guard(): ApiGuard | undefined {
    return this.#guard;
  }

  /** CORS com auth: o cookie cruza origens e as escritas exigem o header anti-CSRF. */
  get csrf(): boolean {
    return this.corsOrigins !== undefined && this.#guard?.accounts !== undefined;
  }

  get prefix(): string {
    return this.#prefix;
  }

  entries(): Iterable<RouteEntry> {
    return this.#entries.values();
  }

  get hasRoutes(): boolean {
    return this.#entries.size > 0;
  }

  state(): string {
    return this.#state();
  }

  /** Tira as rotas de um dono (teardown ou reload do plugin) e fecha as conexões delas. */
  removeOwner(owner: string): void {
    let removed = false;
    for (const [key, entry] of this.#entries) {
      if (entry.owner !== owner) continue;
      this.#entries.delete(key);
      closeSockets(entry);
      removed = true;
    }
    if (removed && this.#attached) this.#hub.changed();
  }

  /**
   * Publica as rotas no servidor; sessão repetida no mesmo servidor é erro de config. `realtime`,
   * do bot, liga `/connection` e `/events` (ADR 0129).
   */
  attach(
    state: () => string,
    realtime?: { readonly connection: ConnectionApiDeps; readonly stream: EventStream },
  ): void {
    this.#hub.attach(this);
    this.#state = state;
    this.#realtime = realtime;
    this.#attached = true;
  }

  /** Abre a porta se alguma sessão tiver rota (e, daqui em diante, quando a primeira chegar). */
  listen(): Promise<void> {
    return this.#hub.listen();
  }

  /** Retira as rotas; o último bot a sair fecha a porta. */
  async detach(): Promise<void> {
    if (!this.#attached) return;
    this.#attached = false;
    // Os streams SSE abertos acabam junto, como os WebSockets das rotas.
    this.#realtime?.stream.close();
    for (const entry of this.#entries.values()) closeSockets(entry);
    this.#entries.clear();
    await this.#hub.detach(this);
  }
}

class HttpHub {
  readonly #options: HttpOptions;
  readonly #sessions = new Map<string, SessionHttp>();
  #app: Hono | undefined;
  #lib: ServerLib | undefined;
  #server: Server | undefined;
  #wss: WebSocketServer | undefined;
  #listening: Promise<void> | undefined;
  #closing: Promise<void> = Promise.resolve();
  // Algum bot terminou o boot: rota que chegar depois (reload) abre a porta na hora.
  #armed = false;

  constructor(options: HttpOptions) {
    this.#options = options;
  }

  get hostname(): string | undefined {
    return this.#options.hostname;
  }

  get port(): number | undefined {
    const address = this.#server?.address();
    return address !== null && typeof address === 'object' ? address.port : undefined;
  }

  attach(session: SessionHttp): void {
    if (this.#sessions.has(session.session)) {
      throw new BotConfigError(
        `http: a sessão "${session.session}" já está ligada a este servidor; cada bot precisa ` +
          'de um `session` diferente',
      );
    }
    this.#sessions.set(session.session, session);
    this.changed();
  }

  async detach(session: SessionHttp): Promise<void> {
    if (this.#sessions.get(session.session) !== session) return;
    this.#sessions.delete(session.session);
    this.changed();
    if (this.#sessions.size === 0) await this.#close();
  }

  changed(): void {
    this.#app = undefined;
    if (this.#armed && this.#listening === undefined && this.#hasRoutes()) {
      this.#listen().catch((error: unknown) =>
        this.#log()?.event(LOG.httpListenFailed, {
          err: error,
          port: this.#options.port,
        }),
      );
    }
  }

  listen(): Promise<void> {
    this.#armed = true;
    return this.#hasRoutes() ? this.#listen() : Promise.resolve();
  }

  #hasRoutes(): boolean {
    for (const session of this.#sessions.values()) if (session.hasRoutes) return true;
    return false;
  }

  #log(): Logger | undefined {
    for (const session of this.#sessions.values()) return session.log();
    return undefined;
  }

  #listen(): Promise<void> {
    if (this.#listening === undefined) {
      // Um fechamento em curso libera a porta antes de abrir de novo.
      const opening = this.#closing.then(() => this.#open());
      this.#listening = opening;
      // Falhou (porta ocupada): a próxima chamada tenta de novo. O erro segue para quem esperou.
      opening.catch(() => {
        if (this.#listening === opening) this.#listening = undefined;
      });
    }
    return this.#listening;
  }

  async #open(): Promise<void> {
    const [{ createAdaptorServer, upgradeWebSocket }, { Hono }, { WebSocketServer }] =
      await Promise.all([import('@hono/node-server'), import('hono'), import('ws'), loadApiLibs()]);
    this.#lib = { Hono, upgradeWebSocket };
    const wss = new WebSocketServer({ noServer: true });
    const server = createAdaptorServer({
      fetch: (request, env) => this.#currentApp().fetch(request, env),
      websocket: { server: wss },
    }) as Server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.#options.port, this.#options.hostname, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (error) => this.#log()?.event(LOG.httpServerError, { err: error }));
    this.#server = server;
    this.#wss = wss;
  }

  async #close(): Promise<void> {
    this.#armed = false;
    const listening = this.#listening;
    if (listening === undefined) return;
    this.#listening = undefined;
    // Abertura que falhou não deixou nada para fechar.
    const closing = listening.then(
      () => this.#shut(),
      () => undefined,
    );
    this.#closing = closing.catch(() => undefined);
    await closing;
  }

  #shut(): Promise<void> {
    const server = this.#server;
    const wss = this.#wss;
    this.#server = undefined;
    this.#wss = undefined;
    if (server === undefined) return Promise.resolve();
    for (const client of wss?.clients ?? []) client.terminate();
    return new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      // Os bots já pararam: requisição em curso (ou keep-alive) não segura o encerramento.
      server.closeAllConnections();
    });
  }

  #currentApp(): Hono {
    // Só há requisição com a porta aberta, e a abertura carregou a lib.
    const lib = this.#lib as ServerLib;
    this.#app ??= this.#build(lib);
    return this.#app;
  }

  #build(lib: ServerLib): Hono {
    const app = new lib.Hono({ strict: false });
    const states = (): Record<string, string> => {
      const sessions: Record<string, string> = {};
      for (const [name, session] of this.#sessions) sessions[name] = session.state();
      return sessions;
    };
    const entries: RouteEntry[] = [];
    const corsAll: string[] = [];
    for (const session of this.#sessions.values()) {
      if (session.corsOrigins !== undefined) {
        corsAll.push(...session.corsOrigins);
        const cors = corsMiddleware(session.corsOrigins);
        app.use(`${session.prefix}/api`, cors);
        app.use(`${session.prefix}/api/*`, cors);
        if (session.csrf) {
          const csrf = csrfMiddleware(session.guard);
          app.use(`${session.prefix}/api`, csrf);
          app.use(`${session.prefix}/api/*`, csrf);
        }
      }
      entries.push(...session.coreEntries(states), ...session.entries());
    }
    // A spec é lida pelo painel no browser: vale a união das allowlists das sessões.
    if (corsAll.length > 0) app.use('/openapi.json', corsMiddleware(corsAll));
    app.get('/health', (c) => {
      const sessions = states();
      const ok = Object.values(sessions).every((state) => state === 'running');
      return c.json({ status: ok ? 'ok' : 'degraded', sessions }, ok ? 200 : 503);
    });
    for (const entry of entries) mount(app, entry, lib.upgradeWebSocket);
    // Gerada a cada pedido da tabela atual: plugin que carrega depois aparece na spec (ADR 0125).
    app.get('/openapi.json', async (c) => {
      try {
        const routes = entries.flatMap((entry) =>
          entry.api
            ? [
                {
                  path: entry.path === '/' ? entry.base() : entry.base() + entry.path,
                  operation: entry.api,
                },
              ]
            : [],
        );
        return c.json(await createOpenApiDocument(routes));
      } catch (error) {
        // Schema de plugin que o gerador recusa: 500 sem detalhe, causa no log.
        this.#log()?.event(LOG.httpUnhandled, { err: error });
        return problemResponse(new ApiError(500));
      }
    });
    app.notFound((c) => {
      if (!/^(\/sessions\/[^/]+)?\/api(\/|$)/.test(c.req.path)) {
        return c.text('404 Not Found', 404);
      }
      // Fora do `mount`, então o trace nasce aqui para o `traceId` do problema (ADR 0120).
      const header = c.req.header('traceparent');
      const trace = parseTraceparent(header) ?? newTraceId();
      return runInTrace(trace, () =>
        withTraceparent(problemResponse(new ApiError(404)), trace, parseTraceFlags(header)),
      );
    });
    app.onError((error, c) => {
      this.#log()?.event(LOG.httpUnhandled, { err: error });
      return c.text('Internal Server Error', 500);
    });
    return app;
  }
}

function mount(app: Hono, entry: RouteEntry, upgradeWebSocket: typeof UpgradeWebSocket): void {
  const base = entry.base();
  const path = entry.path === '/' ? base : base + entry.path;
  const info = (c: Context): HttpRequestInfo => {
    const ip = socketAddress(c.env);
    return { params: c.req.param(), ...(ip !== undefined && { ip }) };
  };
  const { target } = entry;
  if (typeof target === 'function') {
    const handler = target;
    app.on(entry.method, path, (c) => {
      const header = c.req.header('traceparent');
      const trace = parseTraceparent(header) ?? newTraceId();
      // Um trace por request (ADR 0120): o `traceparent` válido de entrada é adotado, para a linha
      // do proxy e a do bot se cruzarem; o header volta na resposta.
      return runInTrace(trace, async () => {
        const started = performance.now();
        let response: Response;
        try {
          const result = await handler(c.req.raw, info(c));
          if (!(result instanceof Response)) {
            throw new TypeError(
              `o handler de ${entry.method} ${entry.path} não devolveu um Response`,
            );
          }
          response = result;
        } catch (error) {
          entry.onError(error);
          response = new Response('Internal Server Error', {
            status: 500,
            headers: { 'content-type': 'text/plain; charset=UTF-8' },
          });
        }
        // Rota e método, nunca query string nem corpo: o `path` é o padrão, sem os valores.
        entry.trail.emit(LOG.httpRequest, {
          method: entry.method,
          route: path,
          status: response.status,
          durationMs: Math.round((performance.now() - started) * 100) / 100,
        });
        return withTraceparent(response, trace, parseTraceFlags(header));
      });
    });
    return;
  }
  app.get(path, async (c, next) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return c.text('Upgrade Required', 426);
    }
    let decided: HttpSocketHandlers | Response;
    try {
      decided = await target.ws(c.req.raw, info(c));
    } catch (error) {
      entry.onError(error);
      return c.text('Internal Server Error', 500);
    }
    if (decided instanceof Response) return decided;
    const handlers = decided;
    const upgrade = upgradeWebSocket(() => socketEvents(entry, handlers), {
      onError: (error) => entry.onError(error),
    });
    return (await upgrade(c, next)) ?? c.text('Internal Server Error', 500);
  });
}

// O `Response` do handler pode ter headers imutáveis (`fetch`, `Response.redirect`): tenta o `set`
// direto e só então copia, com o corpo seguindo como stream. Se nem a cópia vale (`Response.error()`
// tem status 0 e o construtor recusa), devolve a resposta original, sem o header.
// Exportada só para o teste dos três ramos; fora do índice do pacote.
export function withTraceparent(response: Response, trace: string, flags?: string): Response {
  const value = formatTraceparent(trace, flags);
  try {
    response.headers.set('traceparent', value);
    return response;
  } catch {
    // Headers imutáveis: segue para a cópia abaixo.
    void 0;
  }
  // O `Response` do node-server não recusa o status 0 e viraria um 200: o erro de rede fica como está.
  if (response.type === 'error') return response;
  try {
    const headers = new Headers(response.headers);
    headers.set('traceparent', value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}

/** Callbacks do Hono ligados aos do autor, com cada conexão registrada na rota. */
function socketEvents(entry: RouteEntry, handlers: HttpSocketHandlers): WSEvents {
  let socket: HttpSocket | undefined;
  const wrap = (ws: WSContext): HttpSocket => {
    socket ??= {
      // O `ws` do Node aceita qualquer `Uint8Array` (Buffer incluso); o tipo do Hono pede o de
      // `ArrayBuffer` só.
      send: (data) => ws.send(data as string | ArrayBuffer),
      close: (code, reason) => ws.close(code, reason),
    };
    return socket;
  };
  const run = (callback: () => void | Promise<void>): void => {
    try {
      Promise.resolve(callback()).catch(entry.onError);
    } catch (error) {
      entry.onError(error);
    }
  };
  return {
    onOpen(_event, ws) {
      entry.sockets.add(ws);
      run(() => handlers.onOpen?.(wrap(ws)));
    },
    onMessage(event, ws) {
      run(() => handlers.onMessage?.(wrap(ws), event.data as string | ArrayBuffer));
    },
    onClose(event, ws) {
      entry.sockets.delete(ws);
      run(() => handlers.onClose?.(wrap(ws), event.code, event.reason));
    },
  };
}

function closeSockets(entry: RouteEntry): void {
  for (const ws of entry.sockets) ws.close(GOING_AWAY, 'rota removida');
  entry.sockets.clear();
}
