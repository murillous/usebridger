// CORS da API por allowlist de origens (`api.cors.origins`, ADR 0125). Sem config, nada é
// montado: nenhum header CORS. Origem é comparada por igualdade exata; sem curinga, porque a
// auth por cookie (M7-4) exige `credentials` e o navegador recusa `*` com ele.

import type { MiddlewareHandler } from 'hono';
import type { ApiGuard } from '#auth/guard.ts';
import { BotConfigError } from '#config/owners.ts';
import { ApiError, problemResponse } from './problem.ts';

export interface ApiOptions {
  readonly cors?: { readonly origins: readonly string[] };
  /** Liga a autenticação da API. Desligada, a API fica aberta como antes. */
  readonly auth?: {
    /** Inatividade que encerra a sessão; padrão 8 h. */
    readonly sessionIdleMs?: number;
    /** Vida absoluta da sessão; padrão 7 d. */
    readonly sessionMaxAgeMs?: number;
    /**
     * Convite do primeiro `owner` enquanto não há usuário (`POST /api/auth/invites/accept`); depois
     * do primeiro usuário não vale mais. Mínimo de 16 caracteres; guarde em segredo.
     */
    readonly bootstrapToken?: string;
    /**
     * Quantos proxies confiáveis estão na frente da API (0, o padrão, usa o endereço do socket).
     * Com N > 0, o IP do cliente é o N-ésimo de trás para frente do `X-Forwarded-For`; use só se o
     * proxy sobrescreve ou acrescenta o header, ou o cliente forja o IP e escapa do rate limit.
     */
    readonly trustProxy?: number;
  };
}

export function validateApiOptions(api: ApiOptions): void {
  for (const key of ['sessionIdleMs', 'sessionMaxAgeMs'] as const) {
    const value: unknown = api.auth?.[key];
    if (
      value !== undefined &&
      !(typeof value === 'number' && Number.isFinite(value) && value > 0)
    ) {
      throw new BotConfigError(`api.auth.${key}: use um número de milissegundos maior que zero`);
    }
  }
  const hops: unknown = api.auth?.trustProxy;
  if (hops !== undefined && !(typeof hops === 'number' && Number.isInteger(hops) && hops >= 0)) {
    throw new BotConfigError(
      'api.auth.trustProxy: use o número de proxies confiáveis (inteiro >= 0)',
    );
  }
  const boot: unknown = api.auth?.bootstrapToken;
  if (boot !== undefined && !(typeof boot === 'string' && boot.length >= 16)) {
    throw new BotConfigError('api.auth.bootstrapToken: use um texto de pelo menos 16 caracteres');
  }
  if (api.cors === undefined) return;
  const origins: unknown = api.cors.origins;
  if (!(Array.isArray(origins) && origins.every((o) => typeof o === 'string' && o !== ''))) {
    throw new BotConfigError(
      'api.cors.origins: use uma lista de origens (ex.: "https://painel.exemplo.com")',
    );
  }
}

const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

export function corsMiddleware(origins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(origins);
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin === undefined || !allowed.has(origin)) {
      await next();
      // A resposta varia pela origem mesmo quando negada, ou um cache serviria a errada.
      c.res.headers.append('vary', 'Origin');
      return;
    }
    if (c.req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': origin,
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': ALLOW_METHODS,
          'access-control-allow-headers':
            c.req.header('access-control-request-headers') ??
            'content-type, authorization, x-bridger-on-behalf-of, x-bridger-csrf',
          'access-control-max-age': '600',
          vary: 'Origin',
        },
      });
    }
    await next();
    c.res.headers.set('access-control-allow-origin', origin);
    c.res.headers.set('access-control-allow-credentials', 'true');
    c.res.headers.append('vary', 'Origin');
  };
}

/** Header que as escritas vindas de um browser (com `Origin`) precisam mandar contra CSRF. */
export const CSRF_HEADER = 'x-bridger-csrf';

/**
 * Com cookie `SameSite=None` (origem cruzada) qualquer site consegue disparar a escrita; o header
 * custom só passa pelo preflight das origens da allowlist. Bearer não usa cookie, então não precisa.
 */
export function csrfMiddleware(guard?: ApiGuard): MiddlewareHandler {
  return async (c, next) => {
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    if (
      write &&
      c.req.header('origin') !== undefined &&
      c.req.header('authorization') === undefined &&
      !c.req.header(CSRF_HEADER)
    ) {
      // Atribui a recusa a quem a cookie identifica (se identifica): é a tentativa de CSRF.
      const actor = await guard?.authenticate(c.req.raw);
      if (guard !== undefined && actor !== undefined) {
        guard.denied(
          actor,
          `${c.req.method} ${new URL(c.req.url).pathname}`,
          CSRF_HEADER,
          c.req.raw,
          guard.clientIp(c.req.raw, socketAddress(c.env)),
          'csrf',
        );
      }
      return problemResponse(new ApiError(403, `escrita de browser exige o header ${CSRF_HEADER}`));
    }
    await next();
  };
}

type NodeBindings = { incoming?: { socket?: { remoteAddress?: string } } };

/** Endereço do par TCP no ambiente do Hono em Node (às vezes dentro de `env.server`). */
export function socketAddress(env: unknown): string | undefined {
  const bindings = env as (NodeBindings & { server?: NodeBindings }) | undefined;
  return (bindings?.server ?? bindings)?.incoming?.socket?.remoteAddress;
}
