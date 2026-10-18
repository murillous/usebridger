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
    [n('desligado'), 'desligado', 'desligados'],
  ];
  return parts
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`)
    .join(', ');
}
