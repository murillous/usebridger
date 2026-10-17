import {
  definePlugin,
  type HttpHandler,
  type HttpSocket,
  type PluginDefinition,
  secret,
} from '@usebridger/core';
import { z } from '@usebridger/core/zod';
import { COOKIE, createSessions, sameOrigin, tokenMatches } from '#auth.ts';
import { createLogBuffer, type LogEntry } from '#logs.ts';

export interface StatusView {
  transport: string;
  status: 'connecting' | 'open' | 'closed';
  reason?: string;
  message?: string;
  qr?: string;
  pairingCode?: string;
  updatedAt: number;
}

export type { LogEntry } from '#logs.ts';

const unauthorized = (): Response => new Response('não autorizado', { status: 401 });

/** Plugin oficial `dashboard` (ADR 0107, 0108): autenticação, status, QR, logs e WebSocket. */
export const dashboard: PluginDefinition = definePlugin({
  name: 'dashboard',
  version: '0.1.0',
  engine: '<1.0.0',
  config: z.object({
    // Segredo de acesso ao dashboard; o core o mascara em logs e na config exibida.
    token: secret(z.string().min(1)),
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
      status: 'connecting',
      updatedAt: Date.now(),
    };

    const broadcast = (message: unknown): void => {
      if (sockets.size === 0) return;
      let text: string;
      try {
        text = JSON.stringify(message);
      } catch (error) {
        // Campo não serializável (ex.: bigint) num log: o painel perde a linha, o bot segue.
        ctx.log.warn('mensagem do dashboard não serializável', { error });
        return;
      }
      for (const socket of sockets) {
        try {
          socket.send(text);
        } catch {
          // Conexão morta: sai do conjunto; o cliente reconecta e recebe novo snapshot.
          sockets.delete(socket);
        }
      }
    };

    const status = (): StatusView => ({ ...state });

    ctx.events.on('connection.status', ({ payload }) => {
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
      broadcast({ type: 'status', ...status() });
    });
    ctx.events.on('connection.qr', ({ payload }) => {
      state.qr = payload.qr;
      state.updatedAt = Date.now();
      broadcast({ type: 'qr', qr: payload.qr });
    });
    ctx.events.on('connection.pairing-code', ({ payload }) => {
      state.pairingCode = payload.code;
      state.updatedAt = Date.now();
      broadcast({ type: 'pairing-code', code: payload.code });
    });

    // O observador não pode logar nem demorar: só empilha e empurra.
    ctx.observe('log', (signal) => {
      const entry: LogEntry = {
        level: signal.level,
        time: signal.time,
        message: signal.message,
        fields: signal.fields,
      };
      logs.push(entry);
      broadcast({ type: 'log', entry });
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
      let body: unknown;
      try {
        body = await request.json();
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
      guarded(() => Response.json(logs.list())),
    );

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
