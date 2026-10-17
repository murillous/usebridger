import { type FormEvent, useState } from 'react';
import { ApiError, api } from '#web/lib/api.ts';

export function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api('login', { method: 'POST', body: { token } });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? 'Token inválido.' : 'Falha ao entrar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="login card" onSubmit={submit}>
      <h1>Entrar</h1>
      <div className="field">
        <label htmlFor="token">Token de acesso</label>
        <input
          id="token"
          className="input"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'token-err' : undefined}
        />
        {error && (
          <span id="token-err" className="err" role="alert">
            {error}
          </span>
        )}
      </div>
      <button type="submit" className="btn primary" disabled={busy || token === ''}>
        Entrar
      </button>
    </form>
  );
}
