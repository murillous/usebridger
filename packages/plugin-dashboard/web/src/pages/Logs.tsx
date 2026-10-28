import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNotice } from '#web/components/ui.tsx';
import type { components } from '#web/lib/api-types.d.ts';
import { api, unwrap } from '#web/lib/client.ts';
import { useEvent } from '#web/lib/events.ts';

type LogLine = components['schemas']['LogLine'];
type Level = LogLine['level'];

const LEVELS: readonly Level[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

interface Filters {
  level?: Level;
  plugin?: string;
  event?: string;
}

/** Mesma regra do `GET /logs`: nível mínimo e igualdade nos campos `plugin` e `event`. */
export function matches(line: LogLine, filters: Filters): boolean {
  if (filters.level && LEVELS.indexOf(line.level) < LEVELS.indexOf(filters.level)) return false;
  if (filters.plugin && line.fields['plugin'] !== filters.plugin) return false;
  if (filters.event && line.fields['event'] !== filters.event) return false;
  return true;
}

const key = (line: LogLine) => `${line.time}|${line.level}|${line.message}`;

/** Logs: histórico com filtros (`GET /logs`) e as linhas novas ao vivo pelo stream. */
export function Logs() {
  const [draft, setDraft] = useState<Filters>({});
  const [filters, setFilters] = useState<Filters>({});
  const [live, setLive] = useState<LogLine[]>([]);

  const history = useInfiniteQuery({
    queryKey: ['logs', filters],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api().GET('/api/logs', {
          params: {
            query: {
              ...filters,
              ...(pageParam !== undefined && { before: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (page) => page.next,
  });

  useEvent('log', (data) => {
    const line = data as LogLine;
    if (matches(line, filters)) setLive((lines) => [line, ...lines].slice(0, 1000));
  });

  // A página de histórico pode já trazer a linha que o stream mandou: mostra uma vez só.
  const seen = new Set<string>();
  const lines = [...live, ...(history.data?.pages.flatMap((page) => page.logs) ?? [])].filter(
    (line) => {
      const id = key(line);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
  );

  return (
    <section aria-labelledby="logs-t">
      <div className="page-head">
        <h1 id="logs-t">Logs</h1>
      </div>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          setLive([]);
          setFilters(draft);
        }}
      >
        <div className="field">
          <label htmlFor="log-level">Nível mínimo</label>
          <select
            id="log-level"
            className="input"
            value={draft.level ?? ''}
            onChange={(e) => {
              const { level, ...rest } = draft;
              setDraft(e.target.value === '' ? rest : { ...rest, level: e.target.value as Level });
            }}
          >
            <option value="">todos</option>
            {LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="log-plugin">Plugin</label>
          <input
            id="log-plugin"
            className="input"
            value={draft.plugin ?? ''}
            onChange={(e) => setDraft({ ...draft, plugin: e.target.value || undefined })}
          />
        </div>
        <div className="field">
          <label htmlFor="log-event">Evento</label>
          <input
            id="log-event"
            className="input"
            value={draft.event ?? ''}
            onChange={(e) => setDraft({ ...draft, event: e.target.value || undefined })}
          />
        </div>
        <button type="submit" className="btn">
          Filtrar
        </button>
      </form>
      <ErrorNotice error={history.error} />
      <div className="logs" role="log" aria-label="Linhas de log">
        {lines.length === 0 && !history.isPending && <div className="muted">Nenhuma linha.</div>}
        {lines.map((line) => (
          <div key={key(line)} className={`lv-${line.level}`}>
            {new Date(line.time).toLocaleTimeString('pt-BR')} {line.level.toUpperCase()}{' '}
            {typeof line.fields['plugin'] === 'string' && `[${line.fields['plugin']}] `}
            {line.message}
          </div>
        ))}
      </div>
      {history.hasNextPage && (
        <button
          type="button"
          className="btn"
          disabled={history.isFetchingNextPage}
          onClick={() => history.fetchNextPage()}
        >
          Mais antigas
        </button>
      )}
    </section>
  );
}
