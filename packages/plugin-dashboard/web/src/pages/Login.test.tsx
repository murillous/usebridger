// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setUnauthorizedHandler } from '#web/lib/api.ts';
import { Login } from './Login.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setUnauthorizedHandler(() => undefined);
});

const stubFetch = (status: number, body = '') => {
  const fetchMock = vi.fn(async () => new Response(status === 204 ? null : body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

describe('Login', () => {
  it('envia o token para POST api/login e chama o callback no sucesso', async () => {
    const fetchMock = stubFetch(204);
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<Login onDone={onDone} />);
    await user.type(screen.getByLabelText('Token de acesso'), 'segredo');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('api/login');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ token: 'segredo' });
  });

  it('token errado (401) mostra o erro, não chama onDone nem o handler de sessão expirada', async () => {
    stubFetch(401, 'unauthorized');
    const expired = vi.fn();
    setUnauthorizedHandler(expired);
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<Login onDone={onDone} />);
    await user.type(screen.getByLabelText('Token de acesso'), 'errado');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Token inválido.');
    expect(expired).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('Entrar fica desabilitado sem token e Enter envia o formulário', async () => {
    const fetchMock = stubFetch(204);
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<Login onDone={onDone} />);
    expect((screen.getByRole('button', { name: 'Entrar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.type(screen.getByLabelText('Token de acesso'), 'abc{Enter}');
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('Mostrar/Ocultar alterna o tipo do campo', async () => {
    const user = userEvent.setup();
    render(<Login onDone={vi.fn()} />);
    const input = screen.getByLabelText('Token de acesso') as HTMLInputElement;
    expect(input.type).toBe('password');
    await user.click(screen.getByRole('button', { name: 'Mostrar token' }));
    expect(input.type).toBe('text');
    await user.click(screen.getByRole('button', { name: 'Ocultar token' }));
    expect(input.type).toBe('password');
  });
});
