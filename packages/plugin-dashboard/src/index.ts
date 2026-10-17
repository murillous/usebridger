import {
  type ConnectionStatus,
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
  /** Sessão do bot (ADR 0110): `/plugins/dashboard` é a `default`; as outras ficam sob `/sessions/<sessão>`. */
  session: string;
  status: 'connecting' | 'open' | 'closed';
  reason?: string;
  message?: string;
  qr?: string;
  pairingCode?: string;
  updatedAt: number;
}

export type { LogEntry } from '#logs.ts';

const MAX_LOGIN_BODY = 1024;

/** Lê o corpo até `max` bytes; `undefined` se passar (cobre pedido sem content-length). */
async function readLimited(request: Request, max: number): Promise<string | undefined> {
  if (Number(request.headers.get('content-length') ?? 0) > max) return undefined;
  if (request.body === null) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > max) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const unauthorized = (): Response => new Response('não autorizado', { status: 401 });

/** Plugin oficial `dashboard` (ADR 0107, 0108): autenticação, status, QR, logs e WebSocket. */
export const dashboard: PluginDefinition = definePlugin({
  name: 'dashboard',
  version: '0.1.0',
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
      session: ctx.session,
      status: 'connecting',
      updatedAt: Date.now(),
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

    const status = (): StatusView => ({ ...state });

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
      broadcast(JSON.stringify({ type: 'qr', qr: payload.qr }));
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
