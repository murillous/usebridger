import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ErrorNotice, when } from '#web/components/ui.tsx';
import { api, unwrap } from '#web/lib/client.ts';

type Role = 'owner' | 'admin' | 'viewer';
const ROLES: readonly Role[] = ['owner', 'admin', 'viewer'];

/** Link do convite no próprio painel; o token vai no hash, que não chega ao servidor. */
export const inviteLink = (token: string, base: string = document.baseURI): string =>
  new URL(`#/convite?token=${encodeURIComponent(token)}`, base).href;

function Invite({ invite }: { invite: { token: string; expiresAt: string } }) {
  return (
    <div className="notice ok" role="status">
      <p>Convite criado. Envie o link agora: ele não aparece de novo.</p>
      <p className="mono secret-once">{inviteLink(invite.token)}</p>
      <p>Vale até {when(invite.expiresAt)}.</p>
    </div>
  );
}

/** Usuários (`users.manage`): convidar, mudar papel, desativar, encerrar sessões e resetar a senha. */
export function Users() {
  const users = useQuery({ queryKey: ['users'], queryFn: () => unwrap(api().GET('/api/users')) });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [invite, setInvite] = useState<{ token: string; expiresAt: string }>();

  const create = useMutation({
    mutationFn: () => unwrap(api().POST('/api/users', { body: { name, email, role } })),
    onSuccess: (data) => {
      setInvite(data.invite);
      setName('');
      setEmail('');
      users.refetch();
    },
  });
  const act = useMutation({
    mutationFn: async ({ id, action, value }: { id: string; action: string; value?: Role }) => {
      const path = { params: { path: { id } } };
      switch (action) {
        case 'role':
          return unwrap(api().PATCH('/api/users/{id}', { ...path, body: { role: value } }));
        case 'disable':
          return unwrap(api().POST('/api/users/{id}/disable', path));
        case 'enable':
          return unwrap(api().POST('/api/users/{id}/enable', path));
        case 'sessions':
          return unwrap(api().DELETE('/api/users/{id}/sessions', path));
        default:
          return unwrap(api().POST('/api/users/{id}/reset-password', path));
      }
    },
    onSuccess: (data, { action }) => {
      if (action === 'reset') setInvite(data as { token: string; expiresAt: string });
      users.refetch();
    },
  });

  return (
    <section aria-labelledby="users-t">
      <div className="page-head">
        <h1 id="users-t">Usuários</h1>
      </div>
      {invite && <Invite invite={invite} />}
      <form
        className="card filters"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <div className="field">
          <label htmlFor="user-name">Nome</label>
          <input
            id="user-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="user-email">E-mail</label>
          <input
            id="user-email"
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="user-role">Papel</label>
          <select
            id="user-role"
            className="input"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn primary" disabled={create.isPending}>
          Convidar
        </button>
      </form>
      <ErrorNotice error={create.error ?? act.error ?? users.error} />
      <div className="card scroll">
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>Papel</th>
              <th>Estado</th>
              <th>Último login</th>
              <th aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {users.data?.users.map((user) => (
              <tr key={user.id}>
                <td>
                  {user.name}
                  <div className="muted mono">{user.email}</div>
                </td>
                <td>
                  <select
                    className="input"
                    aria-label={`Papel de ${user.name}`}
                    value={user.role}
                    disabled={act.isPending}
                    onChange={(e) =>
                      act.mutate({ id: user.id, action: 'role', value: e.target.value as Role })
                    }
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <span className={user.status === 'active' ? 'chip ok' : 'chip'}>
                    {user.status === 'active' ? 'ativo' : 'desativado'}
                  </span>
                  {user.pendingInvite && <span className="chip info">convite pendente</span>}
                </td>
                <td>{when(user.lastLoginAt)}</td>
                <td>
                  <div className="row">
                    <button
                      type="button"
                      className="btn sm"
                      disabled={act.isPending}
                      onClick={() =>
                        act.mutate({
                          id: user.id,
                          action: user.status === 'active' ? 'disable' : 'enable',
                        })
                      }
                    >
                      {user.status === 'active' ? 'Desativar' : 'Reativar'}
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ id: user.id, action: 'sessions' })}
                    >
                      Encerrar sessões
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={act.isPending}
                      onClick={() => {
                        if (
                          window.confirm(`Resetar a senha de ${user.name}? A atual deixa de valer.`)
                        ) {
                          act.mutate({ id: user.id, action: 'reset' });
                        }
                      }}
                    >
                      Resetar senha
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
