import { describe, expect, it } from 'vitest';
import { contributes, setupText, subtitle } from './plugins.ts';
import { dependentsOf } from './schema.ts';
import type { PluginRow } from './types.ts';

const row = (name: string, extra: Partial<PluginRow> = {}): PluginRow => ({
  name,
  version: '1.0.0',
  origin: 'x',
  status: 'loaded',
  ...extra,
});

describe('report de plugins no painel', () => {
  it('Setup mostra o estado e a duração', () => {
    expect(setupText(row('a', { setupMs: 18 }))).toBe('OK · 18 ms');
    expect(setupText(row('a', { setupMs: 0, unregistered: [{ command: 'x' }] }))).toBe(
      'Parcial (1 comandos fora) · 0 ms',
    );
    expect(setupText(row('a'))).toBe('OK');
    expect(setupText(row('a', { status: 'skipped', reason: { kind: 'setup-failed' } }))).toBe(
      'Falhou',
    );
  });

  it('Contribui mostra ponto ×N', () => {
    expect(
      contributes(
        row('a', {
          contributions: ['dashboard.tabs', 'x.y'],
          contributionCounts: { 'dashboard.tabs': 5 },
        }),
      ),
    ).toBe('dashboard.tabs ×5, x.y');
    expect(contributes(row('a'))).toBe('—');
  });

  it('subtítulo não deixa sufixo vazio com todos os plugins desligados', () => {
    const off = [row('a', { status: 'skipped', reason: { kind: 'disabled' } })];
    const at = new Date(2026, 0, 1, 10, 5, 7).getTime();
    expect(subtitle(off, at)).toBe('Boot de 10:05:07');
    expect(subtitle([row('a')], at)).toBe('Boot de 10:05:07 · 1 carregado');
    expect(subtitle([row('a')], undefined)).toBe('1 carregado');
    expect(subtitle(off, undefined)).toBe('');
  });

  it('dependentsOf segue optionalDependsOn, como o reload em cascata do core', () => {
    const rows: PluginRow[] = [
      row('ai'),
      row('opt', { optionalDependsOn: { ai: '^1' } }),
      row('hard', { dependsOn: { opt: '^1' } }),
      row('alone'),
    ];
    expect(dependentsOf(rows, 'ai').sort()).toEqual(['hard', 'opt']);
  });
});
