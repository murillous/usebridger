// Todos os caminhos são relativos ao `<base href>` que o plugin injeta: nunca um caminho fixo.

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, text: string) {
    super(text || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

let onUnauthorized: () => void = () => undefined;
export const setUnauthorizedHandler = (handler: () => void): void => {
  onUnauthorized = handler;
};

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(`api/${path}`, {
    method: init?.method ?? 'GET',
    credentials: 'same-origin',
    headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    // Erros em texto puro (409, 503...) seguem como string.
    body = text;
  }
  if (!response.ok) {
    // 401 no login é token errado, não sessão expirada.
    if (response.status === 401 && path !== 'login') onUnauthorized();
    throw new ApiError(response.status, body, typeof body === 'string' ? body : '');
  }
  return body as T;
}

/** `ws://` ou `wss://` relativo ao `<base href>`. */
export function liveUrl(base: string = document.baseURI): string {
  const url = new URL('api/ws', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
