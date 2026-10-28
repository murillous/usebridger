import { type FormEvent, useState } from 'react';
import { ApiProblem, api, unwrap } from '#web/lib/client.ts';
import { hashParam } from '#web/lib/route.ts';

const message = (error: unknown): string =>
  error instanceof ApiProblem && error.status === 429
    ? 'Muitas tentativas. Espere um pouco e tente de novo.'
    : error instanceof Error
      ? error.message
      : String(error);

function Gate({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="gate">
      <section className="card login" aria-labelledby="gate-t">
        <h1 id="gate-t">{title}</h1>
        {children}
      </section>
    </div>
  );
}

/** Login por e-mail e senha (`POST /auth/login`); a sessão volta no cookie. */
export function Login({ onDone }: { onDone(): void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await unwrap(api().POST('/api/auth/login', { body: { email, password } }));
      onDone();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Gate title="Entrar">
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="email">E-mail</label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Senha</label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && (
          <p className="notice danger" role="alert">
            {error}
          </p>
        )}
        <div className="row spread">
          <button type="submit" className="btn primary" disabled={busy}>
            Entrar
          </button>
          <a href="#/convite">Tenho um convite</a>
        </div>
      </form>
    </Gate>
  );
}

/**
 * Aceite de convite (`POST /auth/invites/accept`). O link `#/convite?token=...` preenche o token;
 * no primeiro acesso, o `bootstrapToken` da config vale como convite e pede nome e e-mail.
 */
export function AcceptInvite({ onDone }: { onDone(): void }) {
  const [token, setToken] = useState(() => hashParam(window.location.hash, 'token') ?? '');
  const [first, setFirst] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await unwrap(
        api().POST('/api/auth/invites/accept', {
          body: { token, password, ...(first && { name, email }) },
        }),
      );
      // O token não fica no histórico do navegador depois de usado.
      window.history.replaceState(null, '', '#/');
      onDone();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Gate title="Aceitar convite">
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="token">Token do convite</label>
          <input
            id="token"
            className="input mono"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
          />
        </div>
        <label className="row field">
          <input type="checkbox" checked={first} onChange={(e) => setFirst(e.target.checked)} />
          Primeiro acesso (token de bootstrap)
        </label>
        {first && (
          <>
            <div className="field">
              <label htmlFor="name">Nome</label>
              <input
                id="name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="new-email">E-mail</label>
              <input
                id="new-email"
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="new-password">Senha nova</label>
          <input
            id="new-password"
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && (
          <p className="notice danger" role="alert">
            {error}
          </p>
        )}
        <div className="row spread">
          <button type="submit" className="btn primary" disabled={busy}>
            Entrar
          </button>
          <a href="#/">Voltar ao login</a>
        </div>
      </form>
    </Gate>
  );
}
