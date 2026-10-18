import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '#web/lib/api.ts';
import { badgeOf, secretOrigin, validateLocal } from '#web/lib/config-view.ts';
import {
  buildFields,
  buildOverrides,
  dependentsOf,
  type Field,
  type FlatValues,
  flatten,
  groupIssues,
  isDirty,
  leaves,
  listToRows,
  type Node,
  parseNumber,
  recordToRows,
  rowsToList,
  rowsToRecord,
} from '#web/lib/schema.ts';
import type { ChangeResult, ConfigIssue, ConfigResponse, PluginRow } from '#web/lib/types.ts';

interface Loaded {
  nodes: Node[];
  initial: FlatValues;
  sources: Record<string, string>;
  /** Issues da config atual inválida (`view: null`). */
  loadIssues: ConfigIssue[];
  /** `messages.<k>` da view: não são campos do form, mas o PUT precisa devolvê-los se eram override. */
  extra: FlatValues;
  /** Falso com `view: null`: sem `sources` não se sabe quais overrides existem. */
  known: boolean;
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
      : field.control === 'json'
        ? JSON.stringify(v, null, 2)
        : String(v);
  const [text, setText] = useState(() => toText(value));
  const change = (next: string) => {
    setText(next);
    if (field.control === 'json') {
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
  if (field.control === 'json') {
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

/** Lista editável: uma linha por item, com o texto cru guardado (número pela metade não some). */
function ListControl(props: {
  id: string;
  field: Field;
  value: unknown;
  describedBy?: string;
  invalid: boolean;
  onChange: (value: unknown) => void;
}) {
  const [rows, setRows] = useState(() => listToRows(props.value));
  const update = (next: string[]) => {
    setRows(next);
    props.onChange(rowsToList(next, props.field.item ?? 'text'));
  };
  return (
    <fieldset
      className="editor"
      id={props.id}
      aria-labelledby={`${props.id}-lbl`}
      aria-describedby={props.describedBy}
    >
      {rows.map((text, i) => (
        // Índice como chave: as linhas não têm identidade além da posição.
        // biome-ignore lint/suspicious/noArrayIndexKey: ver acima
        <div className="row" key={i}>
          <input
            className="input"
            aria-label={`${props.field.label}, item ${i + 1}`}
            aria-invalid={props.invalid || undefined}
            value={text}
            onChange={(e) => update(rows.map((r, j) => (j === i ? e.target.value : r)))}
          />
          <button
            type="button"
            className="btn"
            aria-label={`Remover item ${i + 1} de ${props.field.label}`}
            onClick={() => update(rows.filter((_, j) => j !== i))}
          >
            Remover
          </button>
        </div>
      ))}
      <button type="button" className="btn" onClick={() => update([...rows, ''])}>
        Adicionar item
      </button>
    </fieldset>
  );
}

/** Pares chave/valor de um record primitivo. */
function RecordControl(props: {
  id: string;
  field: Field;
  value: unknown;
  describedBy?: string;
  invalid: boolean;
  onChange: (value: unknown) => void;
}) {
  const [rows, setRows] = useState(() => recordToRows(props.value));
  const update = (next: [string, string][]) => {
    setRows(next);
    props.onChange(rowsToRecord(next, props.field.item ?? 'text'));
  };
  return (
    <fieldset
      className="editor"
      id={props.id}
      aria-labelledby={`${props.id}-lbl`}
      aria-describedby={props.describedBy}
    >
      {rows.map(([key, value], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: as linhas não têm identidade além da posição
        <div className="row" key={i}>
          <input
            className="input mono"
            aria-label={`${props.field.label}, chave ${i + 1}`}
            aria-invalid={props.invalid || undefined}
            value={key}
            onChange={(e) => update(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
          />
          <input
            className="input"
            aria-label={`${props.field.label}, valor ${i + 1}`}
            aria-invalid={props.invalid || undefined}
            value={value}
            onChange={(e) => update(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
          />
          <button
            type="button"
            className="btn"
            aria-label={`Remover par ${i + 1} de ${props.field.label}`}
            onClick={() => update(rows.filter((_, j) => j !== i))}
          >
            Remover
          </button>
        </div>
      ))}
      <button type="button" className="btn" onClick={() => update([...rows, ['', '']])}>
        Adicionar par
      </button>
    </fieldset>
  );
}

export function FieldView(props: {
  field: Field;
  value: unknown;
  masked: string | undefined;
  source: string | undefined;
  errors: string[];
  /** Form de aba: secret é entrada (senha, sem pré-preencher) em vez da máscara só leitura da Config. */
  secretEditable?: boolean;
  /** Nome do plugin: só para montar o nome real da variável de ambiente do secret. */
  plugin?: string;
  /** Falso com `view: null` (config inválida): a origem do secret é desconhecida. */
  configKnown?: boolean;
  /** Dica do tipo do schema: só na Config, não no form das abas. */
  showHint?: boolean;
  onChange: (value: unknown) => void;
}) {
  const { field, errors } = props;
  const id = `f-${field.path}`;
  const helpId = `${id}-help`;
  const hintId = `${id}-hint`;
  const showHint = props.showHint && errors.length === 0;
  const errId = `${id}-err`;
  // Secret só leitura: a origem real (env ou arquivo) no lugar do texto genérico de override.
  const secretView = field.secret && !props.secretEditable;
  const origin = secretOrigin({
    known: props.configKnown ?? true,
    source: props.source,
    plugin: props.plugin,
    path: field.path,
    hasValue: props.masked !== undefined,
  });
  const help = secretView
    ? [field.description, `${origin} O valor nunca sai do servidor; só a máscara.`]
        .filter(Boolean)
        .join(' · ')
    : [field.description, props.source ? SOURCE_LABEL[props.source] : undefined]
        .filter(Boolean)
        .join(' · ');
  const describedBy =
    [help ? helpId : '', showHint ? hintId : '', errors.length ? errId : '']
      .filter(Boolean)
      .join(' ') || undefined;

  const editor = !field.secret && (field.control === 'list' || field.control === 'record');
  let control: ReactNode;
  if (field.secret && props.secretEditable) {
    control = (
      <input
        id={id}
        className="input mono"
        type="password"
        autoComplete="off"
        value={typeof props.value === 'string' ? props.value : ''}
        aria-invalid={errors.length > 0 || undefined}
        aria-describedby={describedBy}
        onChange={(e) => props.onChange(e.target.value === '' ? undefined : e.target.value)}
      />
    );
  } else if (field.secret) {
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
        style={{ width: 24, height: 24, accentColor: 'var(--ink)' }}
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
  } else if (editor) {
    const Editor = field.control === 'list' ? ListControl : RecordControl;
    control = (
      <Editor
        id={id}
        field={field}
        value={props.value}
        describedBy={describedBy}
        invalid={errors.length > 0}
        onChange={props.onChange}
      />
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
      {/* Fieldset não é rotulável por `for`: os editores usam `aria-labelledby` neste texto. */}
      {editor ? (
        <span className="lbl" id={`${id}-lbl`}>
          {field.label}
        </span>
      ) : (
        <label htmlFor={id}>
          {field.label}
          {secretView && (
            <>
              <span className="chip">secret</span>
              {props.source && (
                <span className={props.source === 'env' ? 'chip info' : 'chip'}>
                  {props.source}
                </span>
              )}
            </>
          )}
        </label>
      )}
      {control}
      {help && (
        <span id={helpId} className="help">
          {help}
        </span>
      )}
      {showHint && (
        <span id={hintId} className="help mono">
          {field.hint} · vem do schema
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
  const [rows, setRows] = useState<PluginRow[]>([]);
  // Erros da config atual por plugin (GET de cada um): alimenta os badges antes de abrir o plugin.
  const [issueCounts, setIssueCounts] = useState<Record<string, number>>({});
  const names = useMemo(() => rows.map((r) => r.name), [rows]);
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
      (list) => {
        setRows(list);
        setPlugin((p) => p ?? list[0]?.name);
        // Plugin sem config legível (ex.: não carregou) fica sem badge de erro: o GET falho é o fallback.
        for (const r of list) {
          api<ConfigResponse>(`config/${encodeURIComponent(r.name)}`).then(
            (d) => setIssueCounts((c) => ({ [r.name]: d.issues?.length ?? 0, ...c })),
            () => undefined,
          );
        }
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
      const nodes = buildFields(data.schema);
      const stop = new Set(leaves(nodes).map((f) => f.path));
      const initial = data.view ? flatten(data.view.config, '', stop) : {};
      const messages = (data.view?.messages ?? {}) as Record<string, unknown>;
      setLoaded({
        nodes,
        initial,
        sources: data.view?.sources ?? {},
        extra: flatten({ messages }),
        known: data.view !== null,
        loadIssues: data.issues ?? [],
      });
      setIssueCounts((c) => ({ ...c, [name]: data.issues?.length ?? 0 }));
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
  // Erro local (limites do schema) antes do 400; mensagem repetida do servidor não duplica.
  const errorsByPath = useMemo(() => {
    const merged: Record<string, string[]> = { ...grouped.byPath };
    for (const [path, msgs] of Object.entries(validateLocal(fields, values))) {
      merged[path] = [...new Set([...(merged[path] ?? []), ...msgs])];
    }
    return merged;
  }, [grouped.byPath, fields, values]);

  const save = async () => {
    if (!plugin || !loaded) return;
    // Sem `sources` o PUT não consegue preservar os overrides que já existem: só segue se a pessoa confirmar.
    if (
      !loaded.known &&
      !window.confirm('Salvar substitui todos os overrides deste plugin. Continuar?')
    ) {
      return;
    }
    setSaving(true);
    setIssues([]);
    setError(undefined);
    setResult(undefined);
    try {
      const overrides = buildOverrides(
        fields,
        loaded.initial,
        values,
        loaded.sources,
        loaded.extra,
      );
      const data = await api<ChangeResult | null>(`config/${encodeURIComponent(plugin)}`, {
        method: 'PUT',
        body: overrides,
      });
      await load(plugin);
      if (data) {
        // Badge "falhou" velho: a linha nova do plugin e dos dependentes vem no resultado.
        const fresh = new Map([data.plugin, ...data.dependents].map((r) => [r.name, r]));
        setRows((old) => old.map((r) => fresh.get(r.name) ?? r));
        setResult(data);
      }
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

  const fieldView = (node: Field) => (
    <FieldView
      key={`${epoch}-${node.path}`}
      plugin={plugin}
      configKnown={loaded?.known}
      showHint
      field={node}
      value={values[node.path]}
      masked={
        typeof loaded?.initial[node.path] === 'string'
          ? String(loaded.initial[node.path])
          : undefined
      }
      source={loaded?.sources[node.path]}
      errors={errorsByPath[node.path] ?? []}
      onChange={(value) => setValues((v) => ({ ...v, [node.path]: value }))}
    />
  );

  // Regra do lado a lado: campos numéricos consecutivos (2 ou mais) entram numa grade de 2
  // colunas; no mobile a grade vira 1 coluna.
  const isNum = (n: Node): n is { node: 'field' } & Field =>
    n.node === 'field' && !n.secret && (n.control === 'number' || n.control === 'integer');
  const render = (nodes: Node[]): ReactNode[] => {
    const out: ReactNode[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i] as Node;
      if (node.node === 'group') {
        out.push(
          <fieldset key={node.path}>
            <legend>{node.label}</legend>
            {render(node.fields)}
          </fieldset>,
        );
      } else if (isNum(node) && nodes[i + 1] && isNum(nodes[i + 1] as Node)) {
        const run: Field[] = [];
        for (let n = nodes[i]; n && isNum(n); n = nodes[i + run.length]) run.push(n);
        out.push(
          <div className="pair" key={`pair-${node.path}`}>
            {run.map(fieldView)}
          </div>,
        );
        i += run.length - 1;
      } else out.push(fieldView(node));
    }
    return out;
  };

  const dependents = plugin ? dependentsOf(rows, plugin) : [];
  const rowOf = (n: string) => rows.find((r) => r.name === n);
  const label = (n: string) => {
    const badge = badgeOf(rowOf(n), issueCounts[n]);
    return badge ? `${n} · ${badge}` : n;
  };

  return (
    <>
      <h1>Config</h1>
      <div className="cfg">
        {/* Desktop: lista lateral; abaixo de 768 px o CSS troca por este select. */}
        <nav className="cfg-nav" aria-label="Plugins">
          {names.map((n) => (
            <button
              key={n}
              type="button"
              className="mono"
              aria-current={n === plugin ? 'true' : undefined}
              onClick={() => setPlugin(n)}
            >
              {n}
              {badgeOf(rowOf(n), issueCounts[n]) && (
                <span
                  className={`chip ${rowOf(n)?.reason?.kind === 'setup-failed' ? 'danger' : 'warn'}`}
                >
                  {badgeOf(rowOf(n), issueCounts[n])}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="field cfg-select">
          <label htmlFor="plugin">Plugin</label>
          <select
            id="plugin"
            className="input"
            value={plugin ?? ''}
            onChange={(e) => setPlugin(e.target.value)}
          >
            {names.map((n) => (
              <option key={n} value={n}>
                {label(n)}
              </option>
            ))}
          </select>
        </div>
        <div className="cfg-body">
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
              <header className="cfg-head">
                <h2 className="mono">{plugin}</h2>
                <span className="muted mono">bridger.config.json · plugins.{plugin}</span>
              </header>
              {loaded.loadIssues.length > 0 && (
                <div className="notice warn" role="alert">
                  A config atual é inválida. Salvar substitui todos os overrides deste plugin.
                  Corrija pelo formulário:
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
              {loaded.nodes.length > 0 && (
                <div className="savebar">
                  <span className="help">
                    Salvar recarrega {plugin}
                    {dependents.length > 0 &&
                      ` e ${dependents.length} ${dependents.length === 1 ? 'dependente' : 'dependentes'}`}{' '}
                    (reload em cascata).
                  </span>
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
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!dirty || saving}
                    onClick={save}
                  >
                    Salvar e recarregar
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
