import type { PluginRow } from './types.ts';

export type PluginState = 'carregado' | 'falhou' | 'pulado' | 'desligado';
export type PluginFilter = 'todos' | 'problema' | 'desligados';

/** Estado do canvas, derivado do que a API já entrega: status e `reason.kind`. */
export function stateOf(row: PluginRow): PluginState {
  if (row.status === 'loaded') return 'carregado';
  if (row.reason?.kind === 'setup-failed') return 'falhou';
  return row.reason?.kind === 'disabled' ? 'desligado' : 'pulado';
}

const FILTERS: Record<PluginFilter, (row: PluginRow) => boolean> = {
  todos: () => true,
  problema: (row) => ['falhou', 'pulado'].includes(stateOf(row)),
  desligados: (row) => stateOf(row) === 'desligado',
};

export const countFilter = (rows: PluginRow[], filter: PluginFilter): number =>
  rows.filter(FILTERS[filter]).length;

export const visible = (rows: PluginRow[], filter: PluginFilter, query: string): PluginRow[] => {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => FILTERS[filter](row) && row.name.toLowerCase().includes(q));
};

/** Dependentes diretos pulados por causa de `name` (nota do painel de erro). */
export const skippedDependents = (rows: PluginRow[], name: string): string[] =>
  rows
    .filter((r) => r.reason?.kind === 'dependency-skipped' && r.reason['dependency'] === name)
    .map((r) => r.name);

/** `hh:mm:ss` do boot, no fuso do navegador. */
export const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString('pt-BR', { hour12: false });

/** `6 carregados, 1 falhou, 1 pulado` (só o que existe). */
export function summary(rows: PluginRow[]): string {
  const n = (state: PluginState) => rows.filter((r) => stateOf(r) === state).length;
  const parts: [number, string, string][] = [
    [n('carregado'), 'carregado', 'carregados'],
    [n('falhou'), 'falhou', 'falharam'],
    [n('pulado'), 'pulado', 'pulados'],
  ];
  return parts
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`)
    .join(', ');
}

export const list = (items: string[] | undefined): string =>
  items?.length ? items.join(', ') : '—';

/** Resultado do `setup`: falhou, carregou com comando de fora, carregou inteiro; `—` se nem rodou. */
export function setupText(row: PluginRow): string {
  if (row.status === 'loaded') {
    const state = row.unregistered?.length
      ? `Parcial (${row.unregistered.length} comandos fora)`
      : 'OK';
    return row.setupMs === undefined ? state : `${state} · ${row.setupMs} ms`;
  }
  return row.reason?.kind === 'setup-failed' ? 'Falhou' : '—';
}

/** `dashboard.tabs ×5`; sem contagem (core antigo), só o nome do ponto. */
export const contributes = (row: PluginRow): string =>
  list(
    row.contributions?.map((point) => {
      const count = row.contributionCounts?.[point];
      return count === undefined ? point : `${point} ×${count}`;
    }),
  );

/** `Boot de hh:mm:ss · 6 carregados`; cada parte some quando vazia (sem sufixo solto). */
export const subtitle = (rows: PluginRow[], bootedAt: number | undefined): string =>
  [bootedAt !== undefined && `Boot de ${clock(bootedAt)}`, summary(rows)]
    .filter(Boolean)
    .join(' · ');
