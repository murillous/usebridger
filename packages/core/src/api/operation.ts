// Operação da API (ADR 0125): método, caminho e schemas Zod de entrada e saída. O mesmo objeto
// vira rota HTTP (validação + problem+json) e entrada da spec OpenAPI.

import type { z } from 'zod';
import type { ApiGuard } from '#auth/guard.ts';
import type { ApiActor } from '#auth/types.ts';
import type { HttpHandler, HttpMethod } from '#http/types.ts';
import { ApiError, type ProblemIssue, problemResponse } from './problem.ts';

export interface ApiOperation<
  Params extends z.ZodType = z.ZodType,
  Query extends z.ZodType = z.ZodType,
  Body extends z.ZodType = z.ZodType,
  Result extends z.ZodType = z.ZodType,
> {
  readonly method: HttpMethod;
  /** Relativo à base da API (`/api`, mais `/plugins/<nome>` no plugin); aceita `:param`. */
  readonly path: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly params?: Params;
  readonly query?: Query;
  readonly body?: Body;
  /** Corpo da resposta de sucesso. Só descreve a spec: o handler não é conferido contra ele. */
  readonly response: Result;
  /** Status de sucesso. Padrão: 200. */
  readonly status?: 200 | 201;
  /**
   * Permissão `<área>.<ação>` exigida do ator. Com a auth ligada (`api.auth`), sem ela basta estar
   * autenticado; sem `public`, a rota nunca fica aberta por esquecimento (ADR 0127).
   */
  readonly permission?: string;
  /** Rota sem autenticação (ex.: `/health`). Exclui `permission`. */
  readonly public?: true;
  readonly handler: (
    input: {
      params: z.output<Params>;
      query: z.output<Query>;
      body: z.output<Body>;
      /** Ator autenticado; `undefined` em rota `public` ou com a auth desligada. */
      actor: ApiActor | undefined;
      /** Endereço do par TCP, para rate limit; `undefined` fora do servidor Node. */
      ip: string | undefined;
    },
    request: Request,
  ) => z.input<Result> | Response | Promise<z.input<Result> | Response>;
}

// biome-ignore lint/suspicious/noExplicitAny: a tabela guarda operações de schemas diferentes
export type AnyApiOperation = ApiOperation<any, any, any, any>;

/** Uma operação no caminho em que foi montada (com prefixo de sessão e `:param`). */
export interface ApiRoute {
  readonly path: string;
  readonly operation: AnyApiOperation;
}

function check(
  where: ProblemIssue['in'],
  schema: z.ZodType | undefined,
  value: unknown,
  issues: ProblemIssue[],
): unknown {
  if (schema === undefined) return undefined;
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    issues.push({
      in: where,
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    });
  }
  return undefined;
}

/** Query string como objeto; chave repetida vira array. */
function queryObject(request: Request): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    const previous = out[key];
    if (previous === undefined) out[key] = value;
    else out[key] = Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  return out;
}

async function readBody(
  schema: z.ZodType,
  request: Request,
  issues: ProblemIssue[],
): Promise<unknown> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // JSON ilegível é entrada inválida do cliente, não falha nossa.
    issues.push({ in: 'body', path: '', message: 'corpo não é JSON válido', code: 'invalid_json' });
    return undefined;
  }
  return check('body', schema, raw, issues);
}

/**
 * Handler HTTP da operação: valida params, query e body, chama o handler e responde JSON. Erro
 * esperado (`ApiError`) e entrada inválida viram problem+json; qualquer outro vai para `onError`
 * (log) e sai como 500 sem mensagem nem stack.
 */
export function operationHandler(
  operation: AnyApiOperation,
  onError: (error: unknown) => void,
  guard?: ApiGuard,
): HttpHandler {
  return async (request, info) => {
    try {
      const ip = guard?.clientIp(request, info.ip) ?? info.ip;
      let actor: ApiActor | undefined;
      if (guard !== undefined && operation.public !== true) {
        actor = await guard.authenticate(request);
        if (actor === undefined) throw new ApiError(401, 'autenticação necessária');
        actor = guard.delegate(actor, `${operation.method} ${operation.path}`, request);
        const { permission } = operation;
        if (permission !== undefined && !actor.permissions.includes(permission)) {
          guard.denied(actor, `${operation.method} ${operation.path}`, permission, request, ip);
          throw new ApiError(403, `permissão necessária: ${permission}`);
        }
      }
      const issues: ProblemIssue[] = [];
      const params = check('path', operation.params, info.params, issues);
      const query = check('query', operation.query, queryObject(request), issues);
      const body =
        operation.body === undefined ? undefined : await readBody(operation.body, request, issues);
      if (issues.length > 0) throw new ApiError(400, 'entrada inválida', issues);
      const input = { params, query, body, actor, ip };
      const result = await (actor !== undefined && guard !== undefined
        ? guard.run(actor, request, () => operation.handler(input, request), ip)
        : operation.handler(input, request));
      // `Response` pronta: a rota precisa de header próprio (ex.: `Set-Cookie` do login).
      if (result instanceof Response) return result;
      return Response.json(result, { status: operation.status ?? 200 });
    } catch (error) {
      // 500 explícito é falha interna: vai para o log e não vaza o detail.
      if (error instanceof ApiError && error.status !== 500) return problemResponse(error);
      onError(error);
      return problemResponse(new ApiError(500));
    }
  };
}
