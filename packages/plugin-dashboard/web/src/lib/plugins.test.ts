import { describe, expect, it } from 'vitest';
import {
  countFilter,
  dependsText,
  skippedDependents,
  stateOf,
  summary,
  visible,
} from './plugins.ts';
import type { PluginRow } from './types.ts';

const row = (name: string, extra: Partial<PluginRow> = {}): PluginRow => ({
  name,
  version: '1.0.0',
  origin: 'x',
  status: 'loaded',
  ...extra,
});
const rows: PluginRow[] = [
  row('ai'),
  row('social', { status: 'skipped', reason: { kind: 'setup-failed' } }),
  row('digest', {
    status: 'skipped',
    reason: { kind: 'dependency-skipped', dependency: 'social' },
  }),
  row('games', { status: 'skipped', reason: { kind: 'disabled' } }),
];

describe('tela de plugins', () => {
  it('deriva o estado do canvas', () => {
    expect(rows.map(stateOf)).toEqual(['carregado', 'falhou', 'pulado', 'desligado']);
  });

  it('conta e filtra por problema, desligados e busca', () => {
    expect(countFilter(rows, 'todos')).toBe(4);
    expect(countFilter(rows, 'problema')).toBe(2);
    expect(countFilter(rows, 'desligados')).toBe(1);
    expect(visible(rows, 'problema', '').map((r) => r.name)).toEqual(['social', 'digest']);
    expect(visible(rows, 'todos', ' GAM ').map((r) => r.name)).toEqual(['games']);
  });

  it('acha os dependentes pulados e resume o boot', () => {
    expect(skippedDependents(rows, 'social')).toEqual(['digest']);
    expect(summary(rows)).toBe('1 carregado, 1 falhou, 1 pulado');
  });
});

describe('dependsText', () => {
  it('lista obrigatórias e depois opcionais com "?"', () => {
    expect(
      dependsText(row('x', { dependsOn: { a: '*' }, optionalDependsOn: { metrics: '*' } })),
    ).toBe('a, metrics?');
    expect(dependsText(row('x', { optionalDependsOn: { metrics: '*' } }))).toBe('metrics?');
    expect(dependsText(row('x'))).toBe('—');
  });
});
