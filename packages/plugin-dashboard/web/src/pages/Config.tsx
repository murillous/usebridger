import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '#web/lib/api.ts';
import {
  buildFields,
  buildOverrides,
  type Field,
  type FlatValues,
  flatten,
  groupIssues,
  isDirty,
  leaves,
  type Node,
  parseList,
  parseNumber,
} from '#web/lib/schema.ts';
import type { ChangeResult, ConfigIssue, ConfigResponse, PluginRow } from '#web/lib/types.ts';

interface Loaded {
  nodes: Node[];
  initial: FlatValues;
  sources: Record<string, string>;
  /** Issues da config atual inválida (`view: null`). */
  loadIssues: ConfigIssue[];
}

const SOURCE_LABEL: Record<string, string> = {
  file: 'definido no arquivo de config; o override não tem efeito',
  env: 'definido no ambiente; o override não tem efeito',
};

/** Campo de texto com o texto cru guardado localmente: "1." ou linha em branco não somem enquanto se digita. */
function TextControl(props: {
  id: string;
  field: Field;
  value: unknown;
  describedBy?: string;
  invalid: boolean;
  onChange: (value: unknown) => void;
}) {
  const { field, value } = props;
  const toText = (v: unknown): string =>
    v === undefined || v === null
      ? ''
      : field.control === 'list'
        ? (v as unknown[]).join('\n')
        : field.control === 'json'
          ? JSON.stringify(v, null, 2)
          : String(v);
  const [text, setText] = useState(() => toText(value));
  const change = (next: string) => {
    setText(next);
    if (field.control === 'list') props.onChange(parseList(next, field.item ?? 'text'));
    else if (field.control === 'json') {
      try {
        props.onChange(next.trim() === '' ? undefined : JSON.parse(next));
      } catch {
        props.onChange(next);
      }
    } else if (field.control === 'text') props.onChange(next === '' ? undefined : next);
    else props.onChange(parseNumber(next));
  };
  const common = {
    id: props.id,
    className: 'input',
    value: text,
    'aria-invalid': props.invalid || undefined,
    'aria-describedby': props.describedBy,
  };
  if (field.control === 'list' || field.control === 'json') {
    return <textarea {...common} onChange={(e) => change(e.target.value)} />;
  }
  const numeric = field.control === 'number' || field.control === 'integer';
  return (
    <input
      {...common}
      type="text"
      inputMode={field.control === 'integer' ? 'numeric' : numeric ? 'decimal' : undefined}
      onChange={(e) => change(e.target.value)}
    />
  );
}

function FieldView(props: {
  field: Field;
  value: unknown;
  masked: string | undefined;
  source: string | undefined;
  errors: string[];
  onChange: (value: unknown) => void;
}) {
  const { field, errors } = props;
  const id = `f-${field.path}`;
  const helpId = `${id}-help`;
  const errId = `${id}-err`;
  const describedBy =
    [field.description || props.source ? helpId : '', errors.length ? errId : '']
      .filter(Boolean)
      .join(' ') || undefined;
  const help = [field.description, props.source ? SOURCE_LABEL[props.source] : undefined]
    .filter(Boolean)
    .join(' · ');

  let control: ReactNode;
  if (field.secret) {
    control = (
      <input
        id={id}
        className="input mono"
        readOnly
        value={props.masked ?? '********'}
        aria-describedby={describedBy}
      />
    );
  } else if (field.control === 'boolean') {
    control = (
      <input
        id={id}
        type="checkbox"
        style={{ width: 24, height: 24 }}
        checked={props.value === true}
        aria-describedby={describedBy}
        onChange={(e) => props.onChange(e.target.checked)}
      />
    );
  } else if (field.control === 'enum') {
    control = (
      <select
        id={id}
        className="input"
        value={props.value === undefined ? '' : String(props.value)}
        aria-invalid={errors.length > 0 || undefined}
        aria-describedby={describedBy}
        onChange={(e) => props.onChange(e.target.value === '' ? undefined : e.target.value)}
      >
        {!field.required && <option value="">—</option>}
        {field.options?.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  } else {
    control = (
      <TextControl
        id={id}
        field={field}
        value={props.value}
        describedBy={describedBy}
        invalid={errors.length > 0}
        onChange={props.onChange}
      />
    );
  }

  return (
    <div className="field">
      <label htmlFor={id}>
        {field.label}
        {field.secret && <span className="muted"> (secret, só leitura)</span>}
      </label>
      {control}
      {help && (
        <span id={helpId} className="help">
          {help}
        </span>
      )}
      {errors.length > 0 && (
        <span id={errId} className="err" role="alert">
          {errors.join(' · ')}
        </span>
      )}
    </div>
  );
}

export function Config() {
  const [names, setNames] = useState<string[]>([]);
  const [plugin, setPlugin] = useState<string>();
  const [loaded, setLoaded] = useState<Loaded>();
  const [values, setValues] = useState<FlatValues>({});
  // Muda a cada (re)carga: remonta os campos e descarta o texto cru digitado.
  const [epoch, setEpoch] = useState(0);
  const [issues, setIssues] = useState<ConfigIssue[]>([]);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ChangeResult>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<PluginRow[]>('plugins').then(
      (rows) => {
        const list = rows.map((r) => r.name);
        setNames(list);
        setPlugin((p) => p ?? list[0]);
      },
      (e) => setError(e instanceof ApiError ? `${e.status}: ${e.message}` : 'Falha de rede.'),
    );
  }, []);

  const load = useCallback(async (name: string) => {
    setLoaded(undefined);
    setIssues([]);
    setError(undefined);
    try {
      const data = await api<ConfigResponse>(`config/${encodeURIComponent(name)}`);
      const initial = data.view ? flatten(data.view.config) : {};
      setLoaded({
        nodes: buildFields(data.schema),
        initial,
        sources: data.view?.sources ?? {},
        loadIssues: data.issues ?? [],
      });
      setValues(initial);
      setEpoch((n) => n + 1);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status}: ${e.message}` : 'Falha de rede.');
    }
  }, []);

  useEffect(() => {
    if (plugin) {
      setResult(undefined);
      void load(plugin);
    }
  }, [plugin, load]);

  const fields = useMemo(() => (loaded ? leaves(loaded.nodes) : []), [loaded]);
  const dirty = loaded ? isDirty(loaded.initial, values) : false;
  const grouped = groupIssues([...(loaded?.loadIssues ?? []), ...issues], fields);

  const save = async () => {
    if (!plugin || !loaded) return;
    setSaving(true);
    setIssues([]);
    setError(undefined);
    setResult(undefined);
    try {
      const overrides = buildOverrides(fields, loaded.initial, values, loaded.sources);
      const data = await api<ChangeResult | null>(`config/${encodeURIComponent(plugin)}`, {
        method: 'PUT',
        body: overrides,
      });
      await load(plugin);
      if (data) setResult(data);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400 && typeof e.body === 'object' && e.body) {
        setIssues((e.body as { issues?: ConfigIssue[] }).issues ?? []);
        setError('Config recusada. Corrija os campos marcados.');
      } else {
        setError(e instanceof ApiError ? `${e.status}: ${e.message}` : 'Falha de rede.');
      }
    } finally {
      setSaving(false);
    }
  };

  const render = (nodes: Node[]) =>
    nodes.map((node) =>
      node.node === 'group' ? (
        <fieldset key={node.path}>
          <legend>{node.label}</legend>
          {render(node.fields)}
        </fieldset>
      ) : (
        <FieldView
          key={`${epoch}-${node.path}`}
          field={node}
          value={values[node.path]}
          masked={
            typeof loaded?.initial[node.path] === 'string'
              ? String(loaded.initial[node.path])
              : undefined
          }
          source={loaded?.sources[node.path]}
          errors={grouped.byPath[node.path] ?? []}
          onChange={(value) => setValues((v) => ({ ...v, [node.path]: value }))}
        />
      ),
    );

  return (
    <>
      <h1>Config</h1>
      <div className="field">
        <label htmlFor="plugin">Plugin</label>
        <select
          id="plugin"
          className="input"
          value={plugin ?? ''}
          onChange={(e) => setPlugin(e.target.value)}
        >
          {names.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </div>
      {error && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}
      {result && (
        <p className="notice ok" role="status">
          Config salva e {result.plugin.name} recarregado
          {result.dependents.length > 0 &&
            ` (dependentes: ${result.dependents.map((d) => d.name).join(', ')})`}
          .{result.teardownErrors.map((t) => ` Erro no teardown de ${t.plugin}: ${t.message}.`)}
        </p>
      )}
      {loaded && (
        <div className="card">
          {loaded.loadIssues.length > 0 && (
            <div className="notice warn" role="alert">
              A config atual é inválida. Corrija pelo formulário:
              <ul>
                {loaded.loadIssues.map((i) => (
                  <li key={`${i.path}-${i.message}`}>
                    <span className="mono">{i.path || '(raiz)'}</span>: {i.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {grouped.orphans.length > 0 && loaded.loadIssues.length === 0 && (
            <ul className="notice danger">
              {grouped.orphans.map((i) => (
                <li key={`${i.path}-${i.message}`}>
                  <span className="mono">{i.path || '(raiz)'}</span>: {i.message}
                </li>
              ))}
            </ul>
          )}
          {loaded.nodes.length === 0 ? (
            <p className="muted">Este plugin não declara config.</p>
          ) : (
            render(loaded.nodes)
          )}
        </div>
      )}
      {loaded && loaded.nodes.length > 0 && (
        <div className="savebar">
          <button type="button" className="btn primary" disabled={!dirty || saving} onClick={save}>
            Salvar
          </button>
          <button
            type="button"
            className="btn"
            disabled={!dirty || saving}
            onClick={() => {
              setValues(loaded.initial);
              setIssues([]);
              setEpoch((n) => n + 1);
            }}
          >
            Descartar
          </button>
        </div>
      )}
    </>
  );
}
