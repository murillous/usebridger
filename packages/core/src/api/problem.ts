// Erros da API em `application/problem+json` (RFC 9457, ADR 0125). Todo erro leva o `traceId` do
// ADR 0120, para o cliente citar na hora de pedir suporte e o operador achar a trilha no log.

import type { z } from 'zod';
import { currentTrace } from '#trace/scope.ts';
import { apiLibs } from './libs.ts';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

const TITLES = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  500: 'Internal Server Error',
} as const;

export type ApiErrorStatus = keyof typeof TITLES;

export interface ProblemIssue {
  readonly in: 'path' | 'query' | 'body';
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string | undefined;
  readonly traceId?: string | undefined;
  readonly errors?: readonly ProblemIssue[] | undefined;
}

/** Componente `Problem` da spec: o corpo de todo erro da API. */
let problem: z.ZodType<ProblemBody> | undefined;

/** Precisa de `loadApiLibs()` antes. */
export function problemSchema(): z.ZodType<ProblemBody> {
  const { z } = apiLibs();
  problem ??= z
    .object({
      type: z
        .string()
        .meta({ description: 'URI do tipo do problema; `about:blank` sem tipo próprio' }),
      title: z.string(),
      status: z.number().int(),
      detail: z.string().optional(),
      traceId: z.string().optional().meta({ description: 'Trace da requisição (ADR 0120)' }),
      errors: z
        .array(
          z.object({
            in: z.enum(['path', 'query', 'body']),
            path: z.string(),
            message: z.string(),
            code: z.string(),
          }),
        )
        .optional()
        .meta({ description: 'Issues de validação (só no 400)' }),
    })
    .meta({ id: 'Problem' });
  return problem;
}

/** Lance de um handler da API para responder um erro esperado (4xx) em problem+json. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: ApiErrorStatus;
  readonly detail: string | undefined;
  readonly issues: readonly ProblemIssue[] | undefined;

  constructor(status: ApiErrorStatus, detail?: string, issues?: readonly ProblemIssue[]) {
    super(detail ?? TITLES[status]);
    this.status = status;
    this.detail = detail;
    this.issues = issues;
  }
}

/** A resposta de um erro. O 500 não leva `detail`: mensagem interna não sai pela rede. */
export function problemResponse(error: ApiError): Response {
  const traceId = currentTrace();
  const body: ProblemBody = {
    type: 'about:blank',
    title: TITLES[error.status],
    status: error.status,
    ...(error.detail !== undefined && { detail: error.detail }),
    ...(traceId !== undefined && { traceId }),
    ...(error.issues !== undefined && { errors: [...error.issues] }),
  };
  return new Response(JSON.stringify(body), {
    status: error.status,
    headers: { 'content-type': PROBLEM_CONTENT_TYPE },
  });
}
