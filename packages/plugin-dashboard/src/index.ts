import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CORE_VERSION,
  type ConnectionStatus,
  definePlugin,
  type HttpHandler,
  type HttpSocket,
  type PluginDefinition,
  secret,
} from '@usebridger/core';
import { z } from '@usebridger/core/zod';
import { COOKIE, createSessions, sameOrigin, tokenMatches } from '#auth.ts';
import { readLimited } from '#body.ts';
import { registerConfigRoutes } from '#config.ts';
import { createLogBuffer, filterByLevel, type LogEntry } from '#logs.ts';
import { registerMetricsRoutes } from '#metrics.ts';
import { registerPluginRoutes } from '#plugins.ts';
import { createStaticHandler } from '#static.ts';
import { registerTabRoutes } from '#tabs.ts';
import { DASHBOARD_VERSION } from '#version.ts';

export interface StatusView {
  transport: string;
  /** Nome do bot (`createBot({ name })`, senão o transport; ADR 0114). */
  name: string;
  /** Sessão do bot (ADR 0110): `/plugins/dashboard` é a `default`; as outras ficam sob `/sessions/<sessão>`. */
  session: string;
  status: 'connecting' | 'open' | 'closed';
  reason?: string;
  message?: string;
  qr?: string;
  pairingCode?: string;
  /** O transport pareia por QR/código: um `auth-failed` limpa a sessão e reconecta, não é terminal. */
  pairing: boolean;
  updatedAt: number;
  /** Desde quando a conexão está no ar (ms epoch); ausente fora do ar (ADR 0114). */
  connectedSince?: number;
  reconnections: number;
  /** Quando o QR atual expira (ms epoch); ausente sem QR ou sem expiração. */
  qrExpiresAt?: number;
  /** Versões exibidas no rodapé da sidebar. */
  versions: { core: string; dashboard: string };
}

export type { LogEntry } from '#logs.ts';
export type {
  DashboardTab,
  DashboardWidget,
  SeriesPoint,
  StatItem,
  TableAction,
  TableColumn,
  TableRow,
} from '#tabs.ts';

const MAX_LOGIN_BODY = 1024;

// No pacote publicado o app fica em `dist/web`, ao lado do bundle; no fonte (`src/`), um nível acima.
const WEB_DIR = fileURLToPath(
  new URL(
    existsSync(new URL('./web/', import.meta.url)) ? './web/' : '../dist/web/',
    import.meta.url,
  ),
);

const unauthorized = (): Response => new Response('não autorizado', { status: 401 });

/** Plugin oficial `dashboard` (ADR 0107, 0108): autenticação, status, QR, logs e WebSocket. */
export const dashboard: PluginDefinition = definePlugin({
  name: 'dashboard',
  version: DASHBOARD_VERSION,
  engine: '<1.0.0',
  config: z.object({
    // Segredo de acesso ao dashboard; o core o mascara em logs e na config exibida.
    token: secret(z.string().min(16)),
    // Quantas linhas de log ficam em memória para o painel.
    logBufferSize: z.number().int().min(1).default(500),
    // Validade do cookie de sessão, em segundos (padrão: 12 h).
    cookieMaxAgeSec: z.number().int().min(60).default(43_200),
  }),
  setup(ctx) {
    const { token, logBufferSize, cookieMaxAgeSec } = ctx.config;
    const sessions = createSessions(cookieMaxAgeSec);
    const logs = createLogBuffer(logBufferSize);
    const sockets = new Set<HttpSocket>();
    const state: StatusView = {
      transport: ctx.transportName,
      name: ctx.botName,
      reconnections: 0,
      session: ctx.session,
      pairing: ctx.capabilities.has('pairing'),
      status: 'connecting',
      updatedAt: Date.now(),
      versions: { core: CORE_VERSION, dashboard: DASHBOARD_VERSION },
    };

    const broadcast = (text: string): void => {
      for (const socket of sockets) {
        try {
          socket.send(text);
        } catch {
          // Conexão morta: sai do conjunto; o cliente reconecta e recebe novo snapshot.
          sockets.delete(socket);
        }
      }
    };

    // Os horários vêm do core a cada leitura: sobrevivem a reload do plugin e não divergem do evento.
    const status = (): StatusView => {
      const { connectedSince, reconnections, qrExpiresAt } = ctx.connectionInfo();
      const view: StatusView = { ...state, reconnections };
      if (connectedSince !== undefined) view.connectedSince = connectedSince;
      if (qrExpiresAt !== undefined && view.qr !== undefined) view.qrExpiresAt = qrExpiresAt;
      return view;
    };

    // Mesma regra para o evento e para o snapshot do core no setup.
    const applyStatus = (payload: ConnectionStatus): void => {
      delete state.reason;
      delete state.message;
      state.status = payload.status;
      state.updatedAt = Date.now();
      if (payload.status === 'open') {
        delete state.qr;
        delete state.pairingCode;
      }
      if (payload.status === 'closed') {
        state.reason = payload.reason;
        // Só o texto do erro, truncado: o objeto cru pode carregar sockets e credenciais.
        if (payload.error instanceof Error) state.message = payload.error.message.slice(0, 300);
      }
    };

    // Depois de um reload (ou plugin tardio) o último status já passou: parte do snapshot do core.
    const initial = ctx.connectionStatus();
    if (initial !== undefined) applyStatus(initial);
    ctx.events.on('connection.status', ({ payload }) => {
      applyStatus(payload);
      broadcast(JSON.stringify({ type: 'status', ...status() }));
    });
    ctx.events.on('connection.qr', ({ payload }) => {
      state.qr = payload.qr;
      state.updatedAt = Date.now();
      broadcast(JSON.stringify({ type: 'qr', qr: payload.qr, qrExpiresAt: payload.expiresAt }));
    });
    ctx.events.on('connection.pairing-code', ({ payload }) => {
      state.pairingCode = payload.code;
      state.updatedAt = Date.now();
      broadcast(JSON.stringify({ type: 'pairing-code', code: payload.code }));
    });

    // O observador não pode logar nem demorar: só empilha e empurra.
    ctx.observe('log', (signal) => {
      let entry: LogEntry = {
        level: signal.level,
        time: signal.time,
        message: signal.message,
        fields: signal.fields,
      };
      let json: string;
      try {
        json = JSON.stringify(entry);
      } catch {
        // Campo com `toJSON` que lança (bigint e ciclo o core já resolve): o buffer só guarda entrada segura, senão
        // /api/logs e o snapshot do WS quebrariam até a linha sair do anel. Aqui não se loga.
        entry = { ...entry, fields: { unserializable: true } };
        json = JSON.stringify(entry);
      }
      logs.push(entry);
      if (sockets.size > 0) broadcast(`{"type":"log","entry":${json}}`);
    });

    const guarded =
      (handler: HttpHandler): HttpHandler =>
      (request, info) =>
        sessions.valid(request) ? handler(request, info) : unauthorized();

    const cookie = (value: string, maxAge: number, request: Request): string => {
      // Secure quando o pedido chegou por https (direto ou via proxy com X-Forwarded-Proto).
      const https =
        new URL(request.url).protocol === 'https:' ||
        request.headers.get('x-forwarded-proto') === 'https';
      return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=${ctx.http.basePath}; Max-Age=${maxAge}${https ? '; Secure' : ''}`;
    };

    ctx.http.route('POST', '/api/login', async (request) => {
      const text = await readLimited(request, MAX_LOGIN_BODY);
      if (text === undefined) return new Response('corpo grande demais', { status: 413 });
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return new Response('JSON inválido', { status: 400 });
      }
      const given =
        typeof body === 'object' && body !== null ? (body as { token?: unknown }).token : undefined;
      if (!tokenMatches(given, token)) return unauthorized();
      return new Response(null, {
        status: 204,
        headers: { 'set-cookie': cookie(sessions.create(), cookieMaxAgeSec, request) },
      });
    });
    ctx.http.route('POST', '/api/logout', (request) => {
      sessions.destroy(request);
      return new Response(null, {
        status: 204,
        headers: { 'set-cookie': cookie('', 0, request) },
      });
    });
    ctx.http.route(
      'GET',
      '/api/status',
      guarded(() => Response.json(status())),
    );
    ctx.http.route(
      'GET',
      '/api/logs',
      guarded((request) => {
        const level = new URL(request.url).searchParams.get('level');
        if (level === null) return Response.json(logs.list());
        const filtered = filterByLevel(logs.list(), level);
        return filtered ? Response.json(filtered) : new Response('nível inválido', { status: 400 });
      }),
    );

    registerConfigRoutes(ctx, guarded);
    registerPluginRoutes(ctx.http, ctx.admin, ctx.log, guarded);
    registerMetricsRoutes(ctx.http, ctx.services, ctx.log, guarded);
    registerTabRoutes(ctx.http, ctx.services.extensionPoint('dashboard.tabs'), ctx.log, guarded);

    ctx.http.ws('/api/ws', (request) => {
      if (!sessions.valid(request) || !sameOrigin(request)) return unauthorized();
      return {
        onOpen(socket) {
          sockets.add(socket);
          socket.send(JSON.stringify({ type: 'snapshot', status: status(), logs: logs.list() }));
        },
        onClose(socket) {
          sockets.delete(socket);
        },
      };
    });

    // App web (SPA). Por último: as rotas `/api/*` registradas acima ganham do `/*`. Sem auth: são só
    // estáticos; os dados passam por `guarded`.
    const serveApp = createStaticHandler(WEB_DIR, ctx.http.basePath);
    ctx.http.route('GET', '/', serveApp);
    ctx.http.route('GET', '/*', serveApp);

    // O core fecha as conexões (1001) ao descer a rota; aqui só limpa o estado.
    ctx.signal.addEventListener(
      'abort',
      () => {
        sockets.clear();
        sessions.clear();
      },
      { once: true },
    );
  },
});
