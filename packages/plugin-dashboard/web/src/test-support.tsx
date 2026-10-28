// Apoio dos testes de componente (happy-dom, ADR 0115): API falsa por rota, `EventSource` falso
// e o app montado sob o `<base href>` que o plugin injeta.

import { QueryClient } from '@tanstack/react-query';
import { act, type RenderResult, render } from '@testing-library/react';
import { vi } from 'vitest';
import { App } from './App.tsx';

export const ORIGIN = 'http://localhost';

/** O plugin serve o app com `<base href="/plugins/dashboard/">`: os caminhos da API saem dele. */
export function useBase(path = '/plugins/dashboard/'): void {
  document.head.querySelector('base')?.remove();
  const base = document.createElement('base');
  base.href = `${ORIGIN}${path}`;
  document.head.append(base);
}

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type Reply = { status?: number; body?: unknown } | undefined;
type Handler = (call: Call) => Reply | Promise<Reply>;

/**
 * `fetch` falso: `routes["GET /api/connection"]` responde; caminho sem rota é 404 problem+json.
 * Guarda as chamadas em `calls`, sem a origem.
 */
export function fakeApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const text = await request.text();
    const call: Call = {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      body: text === '' ? undefined : JSON.parse(text),
    };
    calls.push(call);
    const reply = await routes[`${call.method} ${call.path}`]?.(call);
    if (reply === undefined) {
      return Response.json(
        { type: 'about:blank', title: 'Not Found', status: 404 },
        { status: 404, headers: { 'content-type': 'application/problem+json' } },
      );
    }
    const status = reply.status ?? 200;
    const response =
      reply.body === undefined
        ? new Response(null, { status })
        : Response.json(reply.body, {
            status,
            headers: {
              'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
            },
          });
    // Como no `fetch` de verdade: o cliente lê a URL da resposta.
    Object.defineProperty(response, 'url', { value: request.url });
    return response;
  });
  vi.stubGlobal('fetch', fetch);
  return { calls, fetch };
}

/** Problem+json de erro, no formato da API. */
export const problem = (status: number, detail: string, errors?: unknown[]): Reply => ({
  status,
  body: { type: 'about:blank', title: 'Erro', status, detail, ...(errors && { errors }) },
});

/** `EventSource` falso: os testes mandam eventos com `emit`. */
export class FakeEventSource {
  static last: FakeEventSource | undefined;
  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly #listeners = new Map<string, ((event: { data: string }) => void)[]>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    act(() => this.onopen?.());
  }
  emit(type: string, data: unknown): void {
    act(() => {
      for (const listener of this.#listeners.get(type) ?? [])
        listener({ data: JSON.stringify(data) });
    });
  }
}

export function useFakeEvents(): void {
  FakeEventSource.last = undefined;
  vi.stubGlobal('EventSource', FakeEventSource);
}

/** `GET /auth/me` de quem tem as permissões dadas. */
export const me =
  (permissions: string[], extra: Record<string, unknown> = {}): Handler =>
  () => ({
    body: { id: 'u1', kind: 'user', name: 'Dona', role: 'owner', permissions, ...extra },
  });

/** Spec mínima: só o que o app lê (recursos, métricas). */
export const spec =
  (paths: Record<string, unknown> = {}): Handler =>
  () => ({
    body: { openapi: '3.2.0', paths, components: { schemas: {} } },
  });

export function renderApp(hash = '#/'): RenderResult {
  window.location.hash = hash;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<App client={client} />);
}
