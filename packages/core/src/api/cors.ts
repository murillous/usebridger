// CORS da API por allowlist de origens (`api.cors.origins`, ADR 0125). Sem config, nada é
// montado: nenhum header CORS. Origem é comparada por igualdade exata; sem curinga, porque a
// auth por cookie (M7-4) exige `credentials` e o navegador recusa `*` com ele.

import type { MiddlewareHandler } from 'hono';
import { BotConfigError } from '#config/owners.ts';

export interface ApiOptions {
  readonly cors?: { readonly origins: readonly string[] };
  /** Liga a autenticação da API (ADR 0127). Desligada, a API fica aberta como antes. */
  readonly auth?: {
    /** Inatividade que encerra a sessão; padrão 8 h. */
    readonly sessionIdleMs?: number;
    /** Vida absoluta da sessão; padrão 7 d. */
    readonly sessionMaxAgeMs?: number;
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
            c.req.header('access-control-request-headers') ?? 'content-type, authorization',
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
