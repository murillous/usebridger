import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '#web/lib/api.ts';
import { buildFields, type FlatValues, groupIssues, leaves, unflatten } from '#web/lib/schema.ts';
import type {
  ConfigIssue,
  SeriesPoint,
  StatItem,
  TabRow,
  TabView,
  TabWidget,
} from '#web/lib/types.ts';
import { FieldView } from './Config.tsx';

const GONE = 'Esta aba não está mais disponível.';

const errorText = (e: unknown): string =>
  e instanceof ApiError
    ? e.status === 500
      ? 'Erro ao carregar este widget.'
      : `${e.status}: ${e.message}`
    : 'Falha de rede.';

const path = (tab: TabView, widget: TabWidget): string =>
  `tabs/${encodeURIComponent(tab.plugin)}/${encodeURIComponent(tab.id)}/${encodeURIComponent(widget.id)}`;

function WidgetError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="notice danger" role="alert">
      {message}{' '}
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Tentar de novo
        </button>
      )}
    </div>
  );
}

/** Carrega o dado do widget; erro fica no widget, e 404 avisa a aba (sumiu). */
function useWidgetData<T>(url: string, onGone: () => void) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    setError(undefined);
    try {
      setData(await api<T>(url));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) onGone();
      else setError(errorText(e));
    }
  }, [url, onGone]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, reload: load, setData };
}

function Stats({ url, onGone }: { url: string; onGone: () => void }) {
  const { data, error, reload } = useWidgetData<StatItem[]>(url, onGone);
  if (error) return <WidgetError message={error} onRetry={reload} />;
  if (!data) return <p className="muted">Carregando…</p>;
  return (
    <div className="stats">
      {data.map((s) => (
        <div key={s.label} className="card stat">
          <div className="muted">{s.label}</div>
          <div className="stat-value">{s.value}</div>
          {s.hint && <div className="muted mono">{s.hint}</div>}
        </div>
      ))}
    </div>
  );
}

interface Page {
  rows: TabRow[];
  cursor?: string;
}

function Table({
  tab,
  widget,
  onGone,
}: {
  tab: TabView;
  widget: Extract<TabWidget, { kind: 'table' }>;
  onGone: () => void;
}) {
  const url = path(tab, widget);
  const { data, error, reload, setData } = useWidgetData<Page>(url, onGone);
  const [more, setMore] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  if (error) return <WidgetError message={error} onRetry={reload} />;
  if (!data) return <p className="muted">Carregando…</p>;
  const [first, ...rest] = widget.columns;

  const loadMore = async () => {
    setMore(true);
    try {
      const next = await api<Page>(`${url}?cursor=${encodeURIComponent(data.cursor ?? '')}`);
      setData({
        rows: [...data.rows, ...next.rows],
        ...(next.cursor ? { cursor: next.cursor } : {}),
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) onGone();
      else setActionError(errorText(e));
    } finally {
      setMore(false);
    }
  };

  const run = async (row: TabRow, action: (typeof widget.actions)[number]) => {
    if (action.confirm && !window.confirm(`${action.label}?`)) return;
    setBusy(`${row.id}/${action.id}`);
    setActionError(undefined);
    try {
      await api(`${url}/actions/${encodeURIComponent(action.id)}`, {
        method: 'POST',
        body: { row },
      });
      await reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) onGone();
      else setActionError(errorText(e));
    } finally {
      setBusy(undefined);
    }
  };

  const buttons = (row: TabRow) =>
    widget.actions.length > 0 && (
      <span className="row">
        {widget.actions.map((a) => (
          <button
            key={a.id}
            type="button"
            className="btn"
            disabled={busy !== undefined}
            onClick={() => run(row, a)}
          >
            {a.label}
          </button>
        ))}
      </span>
    );

  return (
    <>
      {actionError && (
        <p className="notice danger" role="alert">
          {actionError}
        </p>
      )}
      {data.rows.length === 0 ? (
        <p className="muted">Nada por aqui.</p>
      ) : (
        <div className="scroll tbl">
          <table>
            <thead>
              <tr>
                {widget.columns.map((c) => (
                  <th key={c.key}>{c.label}</th>
                ))}
                {widget.actions.length > 0 && <th>Ações</th>}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.id}>
                  {widget.columns.map((c) => (
                    <td key={c.key}>{String(row[c.key] ?? '')}</td>
                  ))}
                  {widget.actions.length > 0 && <td>{buttons(row)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="list">
            {data.rows.map((row) => (
              <div key={row.id}>
                <div>{first ? String(row[first.key] ?? '') : row.id}</div>
                <div className="mono muted">
                  {rest.map((c) => `${c.label}: ${String(row[c.key] ?? '')}`).join(' · ')}
                </div>
                {buttons(row)}
              </div>
            ))}
          </div>
        </div>
      )}
      {data.cursor && (
        <button type="button" className="btn" disabled={more} onClick={loadMore}>
          Carregar mais
        </button>
      )}
    </>
  );
}

const DAYS = [7, 30, 90];

function Series({
  tab,
  widget,
  onGone,
}: {
  tab: TabView;
  widget: Extract<TabWidget, { kind: 'series' }>;
  onGone: () => void;
}) {
  const [days, setDays] = useState(30);
  const { data, error, reload } = useWidgetData<SeriesPoint[]>(
    `${path(tab, widget)}?days=${days}`,
    onGone,
  );
  if (error) return <WidgetError message={error} onRetry={reload} />;
  const name = widget.title ?? 'Série';
  const w = 320;
  const h = 80;
  const max = Math.max(1, ...(data ?? []).map((p) => p.value));
  const step = data && data.length > 1 ? w / (data.length - 1) : 0;
  const points = (data ?? [])
    .map((p, i) => `${(i * step).toFixed(1)},${(h - (p.value / max) * h).toFixed(1)}`)
    .join(' ');
  const label =
    data && data.length > 0
      ? `${name}: ${data.length} pontos, de ${data[0]?.label} a ${data[data.length - 1]?.label}, máximo ${max}`
      : `${name}: sem dados`;
  return (
    <div className="card">
      <div className="row spread">
        <h3>{name}</h3>
        <select
          className="input"
          aria-label={`Período de ${name}`}
          style={{ width: 'auto' }}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {DAYS.map((d) => (
            <option key={d} value={d}>
              {d} dias
            </option>
          ))}
        </select>
      </div>
      {!data ? (
        <p className="muted">Carregando…</p>
      ) : (
        <svg
          className="chart"
          viewBox={`-2 -2 ${w + 4} ${h + 4}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
        >
          <polyline points={points} fill="none" stroke="var(--agent)" strokeWidth="2" />
        </svg>
      )}
    </div>
  );
}

function Form({
  tab,
  widget,
  onGone,
}: {
  tab: TabView;
  widget: Extract<TabWidget, { kind: 'form' }>;
  onGone: () => void;
}) {
  const fields = useMemo(() => leaves(buildFields(widget.schema)), [widget.schema]);
  const initial = useMemo(
    () =>
      Object.fromEntries(
        fields.filter((f) => f.default !== undefined).map((f) => [f.path, f.default]),
      ),
    [fields],
  );
  const [values, setValues] = useState<FlatValues>(initial);
  const [epoch, setEpoch] = useState(0);
  const [issues, setIssues] = useState<ConfigIssue[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [sending, setSending] = useState(false);
  const grouped = groupIssues(issues, fields);

  const submit = async () => {
    setSending(true);
    setIssues([]);
    setMessage(undefined);
    // Secret é só leitura no dashboard (mesma regra da Config): nunca vai no corpo.
    const flat: FlatValues = {};
    for (const f of fields)
      if (!f.secret && values[f.path] !== undefined) flat[f.path] = values[f.path];
    try {
      await api(`${path(tab, widget)}/submit`, { method: 'POST', body: unflatten(flat) });
      setMessage({ ok: true, text: 'Enviado.' });
      setValues(initial);
      setEpoch((n) => n + 1);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) onGone();
      else if (e instanceof ApiError && e.status === 400 && typeof e.body === 'object' && e.body) {
        setIssues((e.body as { issues?: ConfigIssue[] }).issues ?? []);
        setMessage({ ok: false, text: 'Dados recusados. Corrija os campos marcados.' });
      } else setMessage({ ok: false, text: errorText(e) });
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {message && (
        <p
          className={`notice ${message.ok ? 'ok' : 'danger'}`}
          role={message.ok ? 'status' : 'alert'}
        >
          {message.text}
        </p>
      )}
      {grouped.orphans.length > 0 && (
        <ul className="notice danger">
          {grouped.orphans.map((i) => (
            <li key={`${i.path}-${i.message}`}>{i.message}</li>
          ))}
        </ul>
      )}
      {fields.map((f) => (
        <FieldView
          key={`${epoch}-${f.path}`}
          field={f}
          value={values[f.path]}
          masked={undefined}
          source={undefined}
          errors={grouped.byPath[f.path] ?? []}
          onChange={(value) => setValues((v) => ({ ...v, [f.path]: value }))}
        />
      ))}
      <button type="submit" className="btn primary" disabled={sending}>
        Enviar
      </button>
    </form>
  );
}

function Widget({ tab, widget, onGone }: { tab: TabView; widget: TabWidget; onGone: () => void }) {
  switch (widget.kind) {
    case 'stats':
      return <Stats url={path(tab, widget)} onGone={onGone} />;
    case 'table':
      return <Table tab={tab} widget={widget} onGone={onGone} />;
    case 'series':
      return <Series tab={tab} widget={widget} onGone={onGone} />;
    case 'form':
      return <Form tab={tab} widget={widget} onGone={onGone} />;
    case 'text':
      // shortcut: markdown sai como texto puro (quebras de linha preservadas); renderizar Markdown quando um caso pedir.
      return <p className="card prewrap">{widget.markdown}</p>;
  }
}

/** Aba contribuída por plugin (ADR 0108): só widgets; o erro de cada um fica nele. */
export function Tab({
  tabs,
  tabKey,
  refresh,
}: {
  tabs: TabView[] | undefined;
  tabKey: string;
  refresh: () => void;
}) {
  const tab = tabs?.find((t) => t.key === tabKey);
  return (
    <>
      <a className="back" href="#/mais">
        ← Mais
      </a>
      {!tabs ? (
        <p className="muted">Carregando…</p>
      ) : !tab ? (
        <p className="notice warn" role="alert">
          {GONE}
        </p>
      ) : (
        <>
          <h1>{tab.title}</h1>
          <p className="muted mono">{tab.plugin}</p>
          {tab.widgets.map((w) => (
            <section key={w.id} aria-label={w.id}>
              <Widget tab={tab} widget={w} onGone={refresh} />
            </section>
          ))}
        </>
      )}
    </>
  );
}
