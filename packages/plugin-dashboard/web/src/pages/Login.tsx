import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api } from '#web/lib/api.ts';
import { loginMessage } from '#web/lib/gate.ts';

/** Portão: cobre o app inteiro enquanto não há sessão. Enter envia (é um `<form>`). */
export function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || token === '') return;
    setBusy(true);
    setError(undefined);
    try {
      await api('login', { method: 'POST', body: { token } });
      onDone();
    } catch (e) {
      setError(loginMessage(e));
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="card login" onSubmit={submit}>
        <h1>Entrar no dashboard</h1>
        <div className="field">
          <label htmlFor="token">Token de acesso</label>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input
              ref={input}
              id="token"
              className="input"
              type={shown ? 'text' : 'password'}
              autoComplete="current-password"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'token-err' : undefined}
            />
            <button
              type="button"
              className="btn"
              aria-label={shown ? 'Ocultar token' : 'Mostrar token'}
              aria-pressed={shown}
              onClick={() => setShown((v) => !v)}
            >
              {shown ? 'Ocultar' : 'Mostrar'}
            </button>
          </div>
          {error && (
            <span id="token-err" className="err" role="alert">
              {error}
            </span>
          )}
        </div>
        <button type="submit" className="btn primary" disabled={busy || token === ''}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
