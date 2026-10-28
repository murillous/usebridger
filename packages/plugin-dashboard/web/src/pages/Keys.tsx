import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useContext, useState } from 'react';
import { ErrorNotice, when } from '#web/components/ui.tsx';
import { api, unwrap } from '#web/lib/client.ts';
import { ViewerContext } from '#web/lib/viewer.ts';

/**
 * API keys (`keys.manage`): criar com escopo e revogar. O escopo só oferece o que quem cria tem,
 * a mesma regra da API (senão 403).
 */
export function Keys() {
  const viewer = useContext(ViewerContext);
  const keys = useQuery({ queryKey: ['keys'], queryFn: () => unwrap(api().GET('/api/keys')) });
  const [name, setName] = useState('');
  const [scope, setScope] = useState<string[]>([]);
  const [secret, setSecret] = useState<string>();

  const create = useMutation({
    mutationFn: () => unwrap(api().POST('/api/keys', { body: { name, permissions: scope } })),
    onSuccess: (data) => {
      setSecret(data.secret);
      setName('');
      setScope([]);
      keys.refetch();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      unwrap(api().DELETE('/api/keys/{id}', { params: { path: { id } } })),
    onSuccess: () => keys.refetch(),
  });

  return (
    <section aria-labelledby="keys-t">
      <div className="page-head">
        <h1 id="keys-t">API keys</h1>
      </div>
      {secret && (
        <div className="notice ok" role="status">
          <p>Chave criada. Copie agora: ela não aparece de novo.</p>
          <p className="mono secret-once">{secret}</p>
        </div>
      )}
      <form
        className="card"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <h2>Nova chave</h2>
        <div className="field">
          <label htmlFor="key-name">Nome</label>
          <input
            id="key-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <fieldset>
          <legend>Permissões</legend>
          {viewer.permissions.map((permission) => (
            <label key={permission} className="row">
              <input
                type="checkbox"
                checked={scope.includes(permission)}
                onChange={(e) =>
                  setScope(
                    e.target.checked
                      ? [...scope, permission]
                      : scope.filter((p) => p !== permission),
                  )
                }
              />
              <span className="mono">{permission}</span>
            </label>
          ))}
        </fieldset>
        <button
          type="submit"
          className="btn primary"
          disabled={create.isPending || scope.length === 0}
        >
          Criar chave
        </button>
      </form>
      <ErrorNotice error={create.error ?? revoke.error ?? keys.error} />
      <div className="card scroll">
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>Permissões</th>
              <th>Último uso</th>
              <th aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {keys.data?.keys.map((key) => (
              <tr key={key.id}>
                <td>{key.name}</td>
                <td className="mono">{key.permissions.join(', ')}</td>
                <td>{when(key.lastUsedAt)}</td>
                <td>
                  {key.revokedAt ? (
                    <span className="chip">revogada</span>
                  ) : (
                    <button
                      type="button"
                      className="btn sm danger"
                      disabled={revoke.isPending}
                      onClick={() => {
                        if (
                          window.confirm(`Revogar ${key.name}? Quem usa a chave perde o acesso.`)
                        ) {
                          revoke.mutate(key.id);
                        }
                      }}
                    >
                      Revogar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
