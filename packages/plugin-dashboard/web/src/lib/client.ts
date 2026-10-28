// Cliente da API do core (ADR 0125): tipado pela spec (`api-types.d.ts`, gerado pelo
// `pnpm gen:api`) nas telas fixas, e `call` para os caminhos que só existem em runtime (recursos e
// rotas de plugin). Os dois tratam erro igual: problem+json vira `ApiProblem`.

import createClient, { type Client } from 'openapi-fetch';
import type { paths } from './api-types.d.ts';
import { endpoints } from './endpoints.ts';

export interface ProblemIssue {
  in?: string;
  path: string;
  message: string;
}

/** Erro da API (RFC 9457), com as issues do 400 por campo. */
export class ApiProblem extends Error {
  readonly status: number;
  readonly errors: readonly ProblemIssue[];
  constructor(status: number, body: unknown) {
    const problem = (typeof body === 'object' && body !== null ? body : {}) as {
      title?: unknown;
      detail?: unknown;
      errors?: unknown;
    };
    const text =
      typeof problem.detail === 'string'
        ? problem.detail
        : typeof problem.title === 'string'
          ? problem.title
          : `HTTP ${status}`;
    super(text);
    this.status = status;
    this.errors = Array.isArray(problem.errors) ? (problem.errors as ProblemIssue[]) : [];
  }
}

let onUnauthorized: () => void = () => undefined;
/** Sessão vencida ou revogada no meio do uso: o app volta ao login. */
export const setUnauthorizedHandler = (handler: () => void): void => {
  onUnauthorized = handler;
};

// O login e o `me` decidem o 401 eles mesmos (senha errada, ainda sem sessão).
const SILENT_401 = /\/api\/auth\/(login|me|invites\/accept)$/;

function check(response: Response): void {
  // `url` vazio (resposta montada à mão, cache) não é login: vale como sessão vencida.
  const path = response.url === '' ? '' : new URL(response.url).pathname;
  if (response.status === 401 && !SILENT_401.test(path)) onUnauthorized();
}

let typed: Client<paths> | undefined;

export function api(): Client<paths> {
  typed ??= createClient<paths>({
    baseUrl: endpoints().base,
    credentials: 'same-origin',
    // Lê o `fetch` a cada chamada: os testes trocam o global depois de criar o cliente.
    fetch: (request) => globalThis.fetch(request),
  });
  return typed;
}

/** Corpo do sucesso, ou lança `ApiProblem`. Para o resultado do cliente tipado. */
export async function unwrap<T>(
  pending: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await pending;
  check(response);
  if (!response.ok) throw new ApiProblem(response.status, error);
  return data as T;
}

/** Chamada a um caminho relativo à API da sessão (`/resources/rank/ranking`). */
export async function call<T>(
  method: string,
  path: string,
  options: { query?: Record<string, string | undefined>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(`${endpoints().api}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    ...(options.body !== undefined && {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options.body),
    }),
  });
  check(response);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    // Resposta que não é JSON (proxy, HTML de erro): segue como texto para a mensagem.
    body = { detail: text.slice(0, 300) };
  }
  if (!response.ok) throw new ApiProblem(response.status, body);
  return body as T;
}
