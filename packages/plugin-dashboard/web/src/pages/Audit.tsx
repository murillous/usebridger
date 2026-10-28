import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNotice, when } from '#web/components/ui.tsx';
import type { components } from '#web/lib/api-types.d.ts';
import { api, unwrap } from '#web/lib/client.ts';
import { endpoints } from '#web/lib/endpoints.ts';

type AuditEvent = components['schemas']['AuditEvent'];
type Outcome = AuditEvent['outcome'];

interface Filters {
  action?: string;
  actor?: string;
  target?: string;
  outcome?: Outcome;
}

const actorName = (actor: AuditEvent['actor']): string => {
  switch (actor.kind) {
    case 'user':
      return actor.onBehalfOf ? `${actor.name} (por ${actor.onBehalfOf})` : actor.name;
    case 'plugin':
      return `plugin ${actor.name}`;
    case 'contact':
      return `contato ${actor.id}`;
    default:
      return actor.kind;
  }
};

/** Auditoria: eventos com filtros, verificação da cadeia e exportação. */
export function Audit() {
  const [draft, setDraft] = useState<Filters>({});
  const [filters, setFilters] = useState<Filters>({});
  const page = useInfiniteQuery({
    queryKey: ['audit', filters],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api().GET('/api/audit', {
          params: { query: { ...filters, ...(pageParam !== undefined && { after: pageParam }) } },
        }),
      ),
    getNextPageParam: (last) => last.next,
  });
  const verify = useMutation({ mutationFn: () => unwrap(api().POST('/api/audit/verify')) });

  // A exportação é um anexo em stream: o navegador baixa direto, com o cookie.
  const exportUrl = (format: 'json' | 'csv') => {
    const url = new URL(`${endpoints().api}/audit/export`);
    url.searchParams.set('format', format);
    for (const [name, value] of Object.entries(filters))
      if (value) url.searchParams.set(name, value);
    return url.href;
  };
  const field = (name: keyof Filters, label: string) => (
    <div className="field">
      <label htmlFor={`audit-${name}`}>{label}</label>
      <input
        id={`audit-${name}`}
        className="input"
        value={draft[name] ?? ''}
        onChange={(e) => setDraft({ ...draft, [name]: e.target.value || undefined })}
      />
    </div>
  );

  return (
    <section aria-labelledby="audit-t">
      <div className="page-head">
        <h1 id="audit-t">Auditoria</h1>
        <div className="row">
          <a className="btn iconbtn" href={exportUrl('csv')} download>
            Exportar CSV
          </a>
          <a className="btn iconbtn" href={exportUrl('json')} download>
            Exportar JSON
          </a>
          <button
            type="button"
            className="btn"
            disabled={verify.isPending}
            onClick={() => verify.mutate()}
          >
            Verificar cadeia
          </button>
        </div>
      </div>
      {verify.data && (
        <p className={verify.data.ok ? 'notice ok' : 'notice danger'} role="status">
          {verify.data.ok
            ? `Cadeia íntegra: ${verify.data.checked} eventos conferidos.`
            : `Cadeia quebrada no evento ${verify.data.brokenAt}.`}
        </p>
      )}
      <ErrorNotice error={verify.error} />
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters(draft);
        }}
      >
        {field('action', 'Ação')}
        {field('actor', 'Ator (id)')}
        {field('target', 'Alvo (id)')}
        <div className="field">
          <label htmlFor="audit-outcome">Resultado</label>
          <select
            id="audit-outcome"
            className="input"
            value={draft.outcome ?? ''}
            onChange={(e) =>
              setDraft({ ...draft, outcome: (e.target.value || undefined) as Outcome | undefined })
            }
          >
            <option value="">todos</option>
            <option value="success">success</option>
            <option value="denied">denied</option>
            <option value="error">error</option>
          </select>
        </div>
        <button type="submit" className="btn">
          Filtrar
        </button>
      </form>
      <ErrorNotice error={page.error} />
      <div className="card scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Quando</th>
              <th>Ação</th>
              <th>Ator</th>
              <th>Alvo</th>
              <th>Resultado</th>
            </tr>
          </thead>
          <tbody>
            {page.data?.pages
              .flatMap((p) => p.events)
              .map((event) => (
                <tr key={event.eventId}>
                  <td className="mono">{event.seq}</td>
                  <td>{when(event.at)}</td>
                  <td className="mono">{event.action}</td>
                  <td>{actorName(event.actor)}</td>
                  <td className="mono">{event.targetId ?? '—'}</td>
                  <td>
                    <span
                      className={
                        event.outcome === 'success'
                          ? 'chip ok'
                          : event.outcome === 'denied'
                            ? 'chip warn'
                            : 'chip danger'
                      }
                    >
                      {event.outcome}
                    </span>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {page.hasNextPage && (
        <button
          type="button"
          className="btn"
          disabled={page.isFetchingNextPage}
          onClick={() => page.fetchNextPage()}
        >
          Mais eventos
        </button>
      )}
    </section>
  );
}
