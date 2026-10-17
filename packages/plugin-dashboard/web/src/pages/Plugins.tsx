import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '#web/lib/api.ts';
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

export function Plugins() {
  const [rows, setRows] = useState<PluginRow[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [result, setResult] = useState<{ action: Action; data: ChangeResult }>();
  const [confirm, setConfirm] = useState<PluginRow>();

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

  const run = async (name: string, action: Action) => {
    setConfirm(undefined);
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

  const actions = (row: PluginRow) => {
    const disabled = busy !== undefined;
    return (
      <span className="row">
        {row.status === 'loaded' ? (
          <>
            <button
              type="button"
              className="btn"
              disabled={disabled}
              onClick={() => run(row.name, 'reload')}
            >
              Recarregar
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={disabled}
              onClick={() => setConfirm(row)}
            >
              Desativar
            </button>
          </>
        ) : row.reason?.kind === 'disabled' ? (
          <button
            type="button"
            className="btn primary"
            disabled={disabled}
            onClick={() => run(row.name, 'enable')}
          >
            Ativar
          </button>
        ) : null}
      </span>
    );
  };

  const state = (row: PluginRow) =>
    row.status === 'loaded' ? (
      <span className="chip ok">Ativo</span>
    ) : (
      <span className="chip warn">Ignorado</span>
    );

  return (
    <>
      <h1>Plugins</h1>
      {error && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="notice ok" role="status">
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
        <div className="card">
          <div className="scroll tbl">
            <table>
              <thead>
                <tr>
                  <th>Plugin</th>
                  <th>Versão</th>
                  <th>Origem</th>
                  <th>Estado</th>
                  <th>Motivo</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.name}>
                    <td className="mono">{row.name}</td>
                    <td className="mono">{row.version}</td>
                    <td>{row.origin}</td>
                    <td>{state(row)}</td>
                    <td>{reasonText(row.reason)}</td>
                    <td>{actions(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="list">
              {rows.map((row) => (
                <div key={row.name}>
                  <div>
                    {row.name} {state(row)}
                  </div>
                  <div className="mono muted">
                    {row.version} · {row.origin} {reasonText(row.reason)}
                  </div>
                  {actions(row)}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {confirm && (
        <div className="overlay">
          <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="cf-t">
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
              <button type="button" className="btn" onClick={() => setConfirm(undefined)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
