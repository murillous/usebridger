import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setUnauthorizedHandler } from './api.ts';
import { loginMessage } from './gate.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(() => undefined);
});

describe('loginMessage', () => {
  it('mapeia o status para a mensagem do campo', () => {
    expect(loginMessage(new ApiError(401, 'x', ''))).toBe('Token inválido.');
    expect(loginMessage(new ApiError(413, null, ''))).toBe('Token grande demais.');
    expect(loginMessage(new ApiError(500, null, ''))).toContain('erro 500');
    expect(loginMessage(new TypeError('fetch failed'))).toContain('Sem conexão');
  });
});

describe('401 em qualquer chamada', () => {
  const respond = (status: number) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('não autorizado', { status })),
    );

  it('leva ao estado deslogado', async () => {
    const loggedOut = vi.fn();
    setUnauthorizedHandler(loggedOut);
    respond(401);
    for (const path of ['status', 'plugins', 'config/x']) {
      await expect(api(path)).rejects.toBeInstanceOf(ApiError);
    }
    expect(loggedOut).toHaveBeenCalledTimes(3);
  });

  it('401 do próprio login (token errado) não desloga; outros erros também não', async () => {
    const loggedOut = vi.fn();
    setUnauthorizedHandler(loggedOut);
    respond(401);
    await expect(api('login', { method: 'POST', body: {} })).rejects.toBeInstanceOf(ApiError);
    respond(500);
    await expect(api('status')).rejects.toBeInstanceOf(ApiError);
    expect(loggedOut).not.toHaveBeenCalled();
  });
});
