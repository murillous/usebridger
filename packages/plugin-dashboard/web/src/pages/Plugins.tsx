import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '#web/lib/api.ts';
import {
  contributes,
  countFilter,
  list,
  type PluginFilter,
  setupText,
  skippedDependents,
  stateOf,
  subtitle,
  visible,
} from '#web/lib/plugins.ts';
import type { ChangeResult, PluginRow, SkipReason } from '#web/lib/types.ts';

type Action = 'enable' | 'disable' | 'reload';

function reasonText(reason: SkipReason | undefined): string {
  if (!reason) return '';
  switch (reason.kind) {
    case 'disabled':
      return 'Desativado';
    case 'engine':
      return `Exige core ${String(reason['range'])} (atual ${String(reason['coreVersion'])})`;
    case 'capabilities':
      return `Capacidades ausentes: ${(reason['missing'] as string[]).join(', ')}`;
    case 'transport':
      return `Exige transport ${(reason['expected'] as string[]).join(', ')} (atual ${String(reason['actual'])})`;
    case 'dependency-missing':
      return `Dependência ausente: ${String(reason['dependency'])}`;
    case 'dependency-skipped':
      return `Dependência ignorada: ${String(reason['dependency'])}`;
    case 'dependency-version':
      return `Dependência ${String(reason['dependency'])} fora da versão ${String(reason['range'])}`;
    case 'setup-failed':
      return `Falha no setup: ${reason.error?.message ?? ''}`;
    default:
      return reason.kind;
  }
}

const errorText = (e: unknown): string =>
  e instanceof ApiError ? `${e.status}: ${e.message}` : 'Falha de rede.';

// O plugin do dashboard não age sobre si mesmo (o servidor responde 409): o nome vem do `basePath`
// em que o app foi servido (`/plugins/<nome>/`).
const SELF = /\/plugins\/([^/]+)\/?$/.exec(new URL(document.baseURI).pathname)?.[1];

export function Plugins() {
  const dialog = useRef<HTMLDivElement>(null);
  const notice = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<PluginRow[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [result, setResult] = useState<{ action: Action; data: ChangeResult }>();
  const [confirm, setConfirm] = useState<PluginRow>();
  const [bootedAt, setBootedAt] = useState<number>();
  const [filter, setFilter] = useState<PluginFilter>('todos');
  const [query, setQuery] = useState('');
  const opener = useRef<HTMLElement | null>(null);
  const ask = (row: PluginRow) => {
    opener.current = document.activeElement as HTMLElement | null;
    setConfirm(row);
  };
  // A linha é redesenhada após a ação e o foco cairia no <body>: vai para o aviso de resultado.
  useEffect(() => {
    if (result) notice.current?.focus();
  }, [result]);
  // Foco inicial no Cancelar (a ação segura) quando o modal abre.
  useEffect(() => {
    if (confirm) dialog.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [confirm]);
  const close = () => {
    setConfirm(undefined);
    opener.current?.focus();
  };

  const load = useCallback(async () => {
    try {
      setRows(await api<PluginRow[]>('plugins'));
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // O horário do boot (real, do core) é enfeite do subtítulo: sem ele a tela segue só com o resumo.
  useEffect(() => {
    api<{ bootedAt: number }>('plugins/boot').then(
      (b) => setBootedAt(b.bootedAt),
      () => setBootedAt(undefined),
    );
  }, []);

  const run = async (name: string, action: Action) => {
    close();
    setBusy(name);
    setResult(undefined);
    try {
      const data = await api<ChangeResult>(`plugins/${encodeURIComponent(name)}/${action}`, {
        method: 'POST',
      });
      setResult({ action, data });
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(undefined);
      await load();
    }
  };

  // Ligado = não desligado: plugin que falhou ou foi pulado segue "ativo" na config, só não carregou; o core aceita desligá-lo.
  const toggle = (row: PluginRow) => {
    const on = row.reason?.kind !== 'disabled';
    const locked = row.name === SELF;
    return (
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={on}
        aria-label={`Ativo: ${row.name}`}
        title={row.name === SELF ? 'Este painel não pode ser alterado por aqui' : undefined}
        disabled={busy !== undefined || locked}
        onClick={() => (on ? ask(row) : run(row.name, 'enable'))}
      />
    );
  };
  const reload = (row: PluginRow) =>
    row.status === 'loaded' && row.name !== SELF ? (
      <button
        type="button"
        className="btn sm"
        aria-label={`Recarregar ${row.name}`}
        disabled={busy !== undefined}
        onClick={() => run(row.name, 'reload')}
      >
        Recarregar
      </button>
    ) : null;

  const chip = (row: PluginRow, short = false) => {
    const state = stateOf(row);
    const kind = { carregado: 'ok', falhou: 'danger', pulado: 'warn', desligado: '' }[state];
    return (
      <span className={`chip ${kind}`} title={reasonText(row.reason) || undefined}>
        {short && state === 'carregado' ? 'ok' : state}
      </span>
    );
  };

  const failed = rows?.filter((r) => stateOf(r) === 'falhou') ?? [];
  const shown = rows ? visible(rows, filter, query) : [];
  const filters: [PluginFilter, string][] = [
    ['todos', 'Todos'],
    ['problema', 'Com problema'],
    ['desligados', 'Desligados'],
  ];
  // Linha compacta do mobile: versão, setup e o que mais explica o plugin.
  const meta = (row: PluginRow) =>
    [
      row.version,
      row.status === 'loaded' ? setupText(row) : undefined,
      row.status === 'loaded'
        ? row.services?.length
          ? `provê ${row.services.join(', ')}`
          : undefined
        : row.reason?.kind === 'dependency-skipped'
          ? `depende de ${String(row.reason['dependency'])}`
          : stateOf(row) === 'pulado'
            ? reasonText(row.reason)
            : undefined,
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <>
      {rows && <p className="muted pl-sub">{subtitle(rows, bootedAt)}</p>}
      <div className="row spread pl-head">
        <h1>Plugins</h1>
        <label className="pl-search">
          <span className="sr">Buscar plugin</span>
          <input
            type="search"
            className="input"
            placeholder="Buscar plugin"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      {error && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="notice ok" role="status" tabIndex={-1} ref={notice}>
          <strong>{result.data.plugin.name}</strong>: {result.action} concluído (
          {result.data.plugin.status === 'loaded' ? 'ativo' : 'ignorado'}).
          {result.data.dependents.length > 0 && (
            <div>
              Dependentes afetados:{' '}
              {result.data.dependents
                .map((d) => `${d.name} (${d.status === 'loaded' ? 'ativo' : 'ignorado'})`)
                .join(', ')}
            </div>
          )}
          {result.data.teardownErrors.map((t) => (
            <div key={`${t.plugin}-${t.phase}`} className="notice warn">
              Erro no teardown de {t.plugin} ({t.phase}
              {t.timedOut ? ', tempo esgotado' : ''}): {t.message}
            </div>
          ))}
        </div>
      )}
      {!rows ? (
        !error && <p className="muted">Carregando…</p>
      ) : (
        <>
          <div className="pl-filters row">
            {filters.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="pl-pill"
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
              >
                {label} {countFilter(rows, id)}
              </button>
            ))}
          </div>
          {failed.map((row) => {
            const dependents = skippedDependents(rows, row.name);
            return (
              <section key={row.name} className="card problem" aria-label={`${row.name} falhou`}>
                <div className="row spread">
                  <h2>
                    <span className="pl-desk">{row.name} · falhou no setup</span>
                    <span className="pl-mob">
                      {row.name} <span className="muted mono">{row.version}</span>
                    </span>
                  </h2>
                  <span className="chip danger pl-mob">falhou</span>
                  <button
                    type="button"
                    className="btn pl-desk"
                    disabled={busy !== undefined}
                    onClick={() => run(row.name, 'reload')}
                  >
                    Recarregar plugin
                  </button>
                </div>
                <pre className="mono errbox">
                  {row.reason?.causeMessage ?? row.reason?.error?.message ?? 'Falha no setup.'}
                </pre>
                {dependents.length > 0 && (
                  <p className="muted pl-small">
                    {dependents.length === 1 ? 'O dependente ' : 'Os dependentes '}
                    <span className="mono">{dependents.join(', ')}</span>{' '}
                    {dependents.length === 1 ? 'foi pulado' : 'foram pulados'} (dependency-skipped).
                    Recarregar o {row.name} reavalia o subgrafo.
                  </p>
                )}
                <div className="row pl-mob actions2">
                  <a className="btn" href="#/config">
                    Abrir config
                  </a>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy !== undefined}
                    onClick={() => run(row.name, 'reload')}
                  >
                    Recarregar
                  </button>
                </div>
              </section>
            );
          })}
          <div className="card">
            <table className="ptable">
              <thead>
                <tr>
                  <th>Plugin</th>
                  <th>Estado</th>
                  <th>Setup</th>
                  <th>Depende de</th>
                  <th>Provê</th>
                  <th>Contribui</th>
                  <th>Ativo</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.name}>
                    <td>
                      <div className="pl-name">{row.name}</div>
                      <div className="mono muted" title={row.origin}>
                        {row.version}
                      </div>
                    </td>
                    <td>{chip(row)}</td>
                    <td className="mono">{setupText(row)}</td>
                    <td className="mono">{list(row.dependsOn && Object.keys(row.dependsOn))}</td>
                    <td className="mono">{list(row.services)}</td>
                    <td className="mono">{contributes(row)}</td>
                    <td>
                      <span className="row">
                        {toggle(row)}
                        {reload(row)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="plist">
              {shown
                .filter((row) => stateOf(row) !== 'falhou')
                .map((row) => (
                  <li key={row.name}>
                    <div>
                      <div className="row">
                        <span className="pl-name">{row.name}</span>
                        {chip(row, true)}
                      </div>
                      <div className="mono muted">{meta(row)}</div>
                    </div>
                    <span className="row">
                      {reload(row)}
                      {toggle(row)}
                    </span>
                  </li>
                ))}
            </ul>
            {shown.length === 0 && <p className="muted">Nenhum plugin encontrado.</p>}
          </div>
        </>
      )}
      {confirm && (
        <div className="overlay">
          <div
            ref={dialog}
            className="modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="cf-t"
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              if (e.key !== 'Tab') return;
              const items = e.currentTarget.querySelectorAll<HTMLElement>('button');
              const first = items[0];
              const last = items[items.length - 1];
              if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last?.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first?.focus();
              }
            }}
          >
            <h2 id="cf-t">Desativar {confirm.name}?</h2>
            <p>O plugin é desmontado e os plugins que dependem dele também saem do ar.</p>
            <div className="row">
              <button
                type="button"
                className="btn danger"
                onClick={() => run(confirm.name, 'disable')}
              >
                Desativar
              </button>
              <button type="button" className="btn" data-autofocus onClick={close}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
