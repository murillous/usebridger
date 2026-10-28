import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { SchemaForm } from '#web/components/SchemaForm.tsx';
import { ErrorNotice } from '#web/components/ui.tsx';
import { ApiProblem, call } from '#web/lib/client.ts';
import { fieldErrors } from '#web/lib/config.ts';
import { href } from '#web/lib/route.ts';
import {
  itemPath,
  type JsonSchema,
  type ResourceAction,
  type ResourceView,
} from '#web/lib/spec.ts';
import { useCan } from '#web/lib/viewer.ts';

type Item = Record<string, unknown>;

/** Colunas da tabela: os campos do topo do schema do item, o `id` primeiro. */
export function columns(item: JsonSchema | undefined): string[] {
  const properties = Object.keys(
    (item?.['properties'] as Record<string, unknown> | undefined) ?? {},
  );
  return properties.includes('id') ? ['id', ...properties.filter((p) => p !== 'id')] : properties;
}

/** Valor de célula: texto direto, o resto em JSON curto. */
export function cell(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/** Só os campos que o schema de entrada declara: o item traz `id` e o que o `update` não aceita. */
function pick(item: Item | undefined, input: JsonSchema | undefined): Item | undefined {
  const keys = Object.keys((input?.['properties'] as Record<string, unknown> | undefined) ?? {});
  if (item === undefined || keys.length === 0) return undefined;
  return Object.fromEntries(Object.entries(item).filter(([key]) => keys.includes(key)));
}

const errorsOf = (error: unknown) =>
  error instanceof ApiProblem ? fieldErrors(error.errors) : undefined;

/** Tela genérica de um `api.resources` (ADR 0134): lista, detalhe, formulários e ações. */
export function Resource({ view, itemId }: { view: ResourceView; itemId?: string }) {
  return itemId === undefined ? (
    <ResourceList key={view.key} view={view} />
  ) : (
    <ResourceItem key={`${view.key}/${itemId}`} view={view} id={itemId} />
  );
}

function FilterInput({
  name,
  schema,
  value,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  value: string;
  onChange(value: string): void;
}) {
  const id = `filter-${name}`;
  const options = Array.isArray(schema['enum'])
    ? (schema['enum'] as unknown[]).map(String)
    : schema['type'] === 'boolean'
      ? ['true', 'false']
      : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{(schema['title'] as string | undefined) ?? name}</label>
      {options ? (
        <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">todos</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          className="input"
          inputMode={
            schema['type'] === 'number' || schema['type'] === 'integer' ? 'decimal' : undefined
          }
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

function ResourceList({ view }: { view: ResourceView }) {
  const can = useCan();
  const queries = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Record<string, string>>({});
  // Pilha de cursores: o topo é a página atual; voltar desempilha.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const [creating, setCreating] = useState(false);
  const list = view.list;

  const page = useQuery({
    queryKey: ['resource', view.key, 'list', filter, cursor],
    enabled: list !== undefined,
    queryFn: () =>
      call<{ items: Item[]; cursor?: string }>('GET', list?.path ?? '', {
        query: {
          // Filtro vazio não vai: o core recusaria `min=` num número.
          ...Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== '')),
          ...(cursor !== undefined && { cursor }),
        },
      }),
  });
  const create = useMutation({
    mutationFn: (input: unknown) => call<Item>('POST', view.create?.path ?? '', { body: input }),
    onSuccess: () => {
      setCreating(false);
      queries.invalidateQueries({ queryKey: ['resource', view.key] });
    },
  });

  const cols = columns(view.item);
  const canOpen =
    view.get !== undefined ||
    view.update !== undefined ||
    view.delete !== undefined ||
    view.actions.length > 0;

  return (
    <section aria-labelledby="res-t">
      <div className="page-head">
        <div>
          <h1 id="res-t">{view.resource}</h1>
          <p className="muted">
            Recurso do plugin <span className="mono">{view.plugin}</span>
            {view.summary && ` · ${view.summary}`}
          </p>
        </div>
        {view.create && can(view.create.permission) && (
          <button type="button" className="btn primary" onClick={() => setCreating((c) => !c)}>
            {creating ? 'Cancelar' : 'Novo'}
          </button>
        )}
      </div>
      {creating && view.create?.input && (
        <div className="card">
          <h2>Novo item</h2>
          <SchemaForm
            schema={view.create.input}
            submitLabel="Criar"
            busy={create.isPending}
            extraErrors={errorsOf(create.error)}
            onSubmit={(data) => create.mutate(data)}
          />
          <ErrorNotice error={create.error} />
        </div>
      )}
      {view.filters.length > 0 && (
        <form
          className="filters"
          onSubmit={(event) => {
            event.preventDefault();
            setCursors([undefined]);
            setFilter(draft);
          }}
        >
          {view.filters.map((f) => (
            <FilterInput
              key={f.name}
              name={f.name}
              schema={f.schema}
              value={draft[f.name] ?? ''}
              onChange={(value) => setDraft({ ...draft, [f.name]: value })}
            />
          ))}
          <button type="submit" className="btn">
            Filtrar
          </button>
        </form>
      )}
      <ErrorNotice error={page.error} />
      {list === undefined && <p className="muted">Este recurso não tem listagem.</p>}
      {page.data && (
        <div className="card scroll">
          {page.data.items.length === 0 ? (
            <p className="muted">Nenhum item.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  {cols.map((col) => (
                    <th key={col}>{col}</th>
                  ))}
                  {canOpen && <th aria-label="Ações" />}
                </tr>
              </thead>
              <tbody>
                {page.data.items.map((item, index) => (
                  <tr key={typeof item['id'] === 'string' ? item['id'] : index}>
                    {cols.map((col) => (
                      <td key={col} className={col === 'id' ? 'mono' : undefined}>
                        {cell(item[col])}
                      </td>
                    ))}
                    {canOpen && (
                      <td>
                        {typeof item['id'] === 'string' && (
                          <a href={href('recursos', view.plugin, view.resource, item['id'])}>
                            Abrir
                          </a>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <div className="row">
        {cursors.length > 1 && (
          <button type="button" className="btn" onClick={() => setCursors(cursors.slice(0, -1))}>
            Anterior
          </button>
        )}
        {page.data?.cursor !== undefined && (
          <button
            type="button"
            className="btn"
            onClick={() => setCursors([...cursors, page.data?.cursor])}
          >
            Próxima
          </button>
        )}
      </div>
    </section>
  );
}

function ActionPanel({
  action,
  id,
  onDone,
}: {
  action: ResourceAction;
  id: string;
  onDone(): void;
}) {
  const [open, setOpen] = useState(false);
  const run = useMutation({
    mutationFn: (input: unknown) =>
      call<unknown>('POST', itemPath(action.path, id), {
        ...(input !== undefined && { body: input }),
      }),
    onSuccess: () => {
      setOpen(false);
      onDone();
    },
  });
  const label = action.summary ?? action.id;
  const confirmed = () => !action.confirm || window.confirm(`${label}: confirmar?`);

  return (
    <div className="card">
      <div className="row spread">
        <strong>{label}</strong>
        {action.input ? (
          <button type="button" className="btn" onClick={() => setOpen((o) => !o)}>
            {open ? 'Cancelar' : label}
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={run.isPending}
            onClick={() => {
              if (confirmed()) run.mutate(undefined);
            }}
          >
            Executar
          </button>
        )}
      </div>
      {open && action.input && (
        <SchemaForm
          schema={action.input}
          submitLabel="Executar"
          busy={run.isPending}
          extraErrors={errorsOf(run.error)}
          onSubmit={(data) => {
            if (confirmed()) run.mutate(data);
          }}
        />
      )}
      <ErrorNotice error={run.error} />
      {run.isSuccess && run.data !== null && Object.keys(run.data as object).length > 0 && (
        <pre className="mono">{JSON.stringify(run.data, null, 2)}</pre>
      )}
    </div>
  );
}

function ResourceItem({ view, id }: { view: ResourceView; id: string }) {
  const can = useCan();
  const queries = useQueryClient();
  const back = href('recursos', view.plugin, view.resource);
  const item = useQuery({
    queryKey: ['resource', view.key, 'item', id],
    enabled: view.get !== undefined,
    queryFn: () => call<Item>('GET', itemPath(view.get?.path ?? '', id)),
  });
  const refresh = () => queries.invalidateQueries({ queryKey: ['resource', view.key] });
  const update = useMutation({
    mutationFn: (input: unknown) =>
      call<Item>('PATCH', itemPath(view.update?.path ?? '', id), { body: input }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => call<unknown>('DELETE', itemPath(view.delete?.path ?? '', id)),
    onSuccess: () => {
      refresh();
      window.location.hash = back;
    },
  });

  return (
    <section aria-labelledby="item-t">
      <div className="page-head">
        <h1 id="item-t" className="mono">
          {id}
        </h1>
        <a href={back}>Voltar a {view.resource}</a>
      </div>
      <ErrorNotice error={item.error} />
      {item.data && (
        <div className="card">
          <dl className="facts">
            {Object.entries(item.data).map(([key, value]) => (
              <div key={key} style={{ display: 'contents' }}>
                <dt>{key}</dt>
                <dd>{cell(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {view.update?.input && can(view.update.permission) && (
        <div className="card">
          <h2>Editar</h2>
          <SchemaForm
            schema={view.update.input}
            formData={pick(item.data, view.update.input)}
            submitLabel="Salvar"
            busy={update.isPending}
            extraErrors={errorsOf(update.error)}
            onSubmit={(data) => update.mutate(data)}
          />
          <ErrorNotice error={update.error} />
          {update.isSuccess && (
            <p className="notice ok" role="status">
              Salvo.
            </p>
          )}
        </div>
      )}
      {view.actions
        .filter((action) => can(action.permission))
        .map((action) => (
          <ActionPanel key={action.id} action={action} id={id} onDone={refresh} />
        ))}
      {view.delete && can(view.delete.permission) && (
        <button
          type="button"
          className="btn danger"
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`Remover ${id}?`)) remove.mutate();
          }}
        >
          Remover
        </button>
      )}
      <ErrorNotice error={remove.error} />
    </section>
  );
}
