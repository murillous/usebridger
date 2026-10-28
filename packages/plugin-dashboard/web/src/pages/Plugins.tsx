import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorNotice } from '#web/components/ui.tsx';
import { api, unwrap } from '#web/lib/client.ts';
import { href } from '#web/lib/route.ts';
import { useCan } from '#web/lib/viewer.ts';

/** Plugins: estado do boot, ligar e desligar (ADR 0131) e o caminho para a config. */
export function Plugins() {
  const can = useCan();
  const queries = useQueryClient();
  const list = useQuery({
    queryKey: ['plugins'],
    queryFn: () => unwrap(api().GET('/api/plugins')),
  });
  const toggle = useMutation({
    mutationFn: ({ name, enable }: { name: string; enable: boolean }) =>
      unwrap(
        api().POST(enable ? '/api/plugins/{name}/enable' : '/api/plugins/{name}/disable', {
          params: { path: { name } },
        }),
      ),
    onSettled: () => {
      queries.invalidateQueries({ queryKey: ['plugins'] });
      queries.invalidateQueries({ queryKey: ['spec'] });
    },
  });

  return (
    <section aria-labelledby="plugins-t">
      <div className="page-head">
        <h1 id="plugins-t">Plugins</h1>
      </div>
      <ErrorNotice error={list.error ?? toggle.error} />
      {list.data && (
        <div className="card scroll">
          <table>
            <thead>
              <tr>
                <th>Plugin</th>
                <th>Estado</th>
                <th>Setup</th>
                <th>Ativo</th>
              </tr>
            </thead>
            <tbody>
              {list.data.plugins.map((plugin) => {
                const loaded = plugin.status === 'loaded';
                const reason = (plugin as { reason?: { kind: string; message: string } }).reason;
                return (
                  <tr key={plugin.name}>
                    <td>
                      <strong>{plugin.name}</strong>{' '}
                      <span className="mono muted">{plugin.version}</span>
                      {can('config.read') && (
                        <div>
                          <a href={href('plugins', plugin.name)}>Config</a>
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={loaded ? 'chip ok' : 'chip warn'}>
                        {loaded ? 'carregado' : 'fora'}
                      </span>
                      {reason && <div className="muted">{reason.message}</div>}
                    </td>
                    <td className="mono">
                      {plugin.setupMs !== undefined ? `${Math.round(plugin.setupMs)} ms` : '—'}
                    </td>
                    <td>
                      <button
                        type="button"
                        role="switch"
                        className="switch"
                        aria-checked={loaded}
                        aria-label={`${loaded ? 'Desligar' : 'Ligar'} ${plugin.name}`}
                        disabled={!can('plugins.manage') || toggle.isPending}
                        onClick={() => {
                          if (
                            !loaded ||
                            window.confirm(
                              `Desligar ${plugin.name}? Os plugins que dependem dele descem junto.`,
                            )
                          ) {
                            toggle.mutate({ name: plugin.name, enable: !loaded });
                          }
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
