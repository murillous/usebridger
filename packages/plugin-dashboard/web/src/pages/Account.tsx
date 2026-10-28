import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ErrorNotice, when } from '#web/components/ui.tsx';
import { api, unwrap } from '#web/lib/client.ts';

/** Minha conta: trocar a senha e ver ou encerrar as próprias sessões. */
export function Account({ onLogout }: { onLogout(): void }) {
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => unwrap(api().GET('/api/auth/sessions')),
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      unwrap(api().DELETE('/api/auth/sessions/{id}', { params: { path: { id } } })),
    onSuccess: (_data, id) => {
      // Encerrar a sessão atual é sair.
      if (sessions.data?.sessions.find((s) => s.id === id)?.current) onLogout();
      else sessions.refetch();
    },
  });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const password = useMutation({
    mutationFn: () =>
      unwrap(
        api().POST('/api/auth/password', {
          body: { currentPassword: current, newPassword: next },
        }),
      ),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      sessions.refetch();
    },
  });

  return (
    <section aria-labelledby="account-t">
      <div className="page-head">
        <h1 id="account-t">Minha conta</h1>
      </div>
      <form
        className="card"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          password.mutate();
        }}
      >
        <h2>Trocar senha</h2>
        <div className="field">
          <label htmlFor="current-password">Senha atual</label>
          <input
            id="current-password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="next-password">Senha nova</label>
          <input
            id="next-password"
            className="input"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
          />
        </div>
        <ErrorNotice error={password.error} />
        {password.isSuccess && (
          <p className="notice ok" role="status">
            Senha trocada; as outras sessões foram encerradas.
          </p>
        )}
        <button type="submit" className="btn primary" disabled={password.isPending}>
          Trocar senha
        </button>
      </form>
      <div className="card scroll">
        <h2>Minhas sessões</h2>
        <ErrorNotice error={sessions.error ?? revoke.error} />
        <table>
          <thead>
            <tr>
              <th>Criada</th>
              <th>Último uso</th>
              <th>Expira</th>
              <th aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {sessions.data?.sessions.map((session) => (
              <tr key={session.id}>
                <td>
                  {when(session.createdAt)}
                  {session.current && <span className="chip info"> esta</span>}
                </td>
                <td>{when(session.lastSeenAt)}</td>
                <td>{when(session.expiresAt)}</td>
                <td>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(session.id)}
                  >
                    Encerrar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
