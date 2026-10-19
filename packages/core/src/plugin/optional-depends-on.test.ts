// `optionalDependsOn` (#84, ADR 0095): ordena como o `after` e é validado no manifesto.

import { describe, expect, it } from 'vitest';
import { manifestIssues } from './define.ts';
import { PluginCycleError, sortPlugins } from './order.ts';

const valid = {
  name: 'download',
  version: '1.0.0',
  engine: '>=0.0.0',
  setup: () => undefined,
};

describe('optionalDependsOn no manifesto', () => {
  it('aceita um objeto nome → faixa semver, como o dependsOn', () => {
    expect(manifestIssues({ ...valid, optionalDependsOn: { sticker: '^0.1.0' } })).toEqual([]);
  });

  it.each([
    [
      'lista em vez de objeto',
      { optionalDependsOn: ['sticker'] },
      /optionalDependsOn deve ser um objeto/,
    ],
    ['que não é objeto', { optionalDependsOn: 'sticker' }, /optionalDependsOn deve ser um objeto/],
    [
      'com faixa inválida',
      { optionalDependsOn: { sticker: 'qualquer' } },
      /optionalDependsOn\["sticker"\]/,
    ],
    ['com nome inválido', { optionalDependsOn: { Sticker: '^1.0.0' } }, /optionalDependsOn: nome/],
    [
      'em si mesmo',
      { optionalDependsOn: { download: '^1.0.0' } },
      /optionalDependsOn não pode citar/,
    ],
    [
      'repetindo o dependsOn',
      { dependsOn: { sticker: '^1.0.0' }, optionalDependsOn: { sticker: '^1.0.0' } },
      /"sticker" está em dependsOn e optionalDependsOn/,
    ],
  ])('%s', (_, patch, pattern) => {
    expect(manifestIssues({ ...valid, ...patch }).join('\n')).toMatch(pattern);
  });
});

describe('optionalDependsOn na ordem de carga', () => {
  const names = (plugins: Parameters<typeof sortPlugins>[0]) =>
    sortPlugins(plugins).map((plugin) => plugin.name);

  it('carrega o provedor antes, sem exigir que exista', () => {
    expect(
      names([
        { name: 'download', optionalDependsOn: { sticker: '^1.0.0', fantasma: '^1.0.0' } },
        { name: 'sticker' },
      ]),
    ).toEqual(['sticker', 'download']);
  });

  it('entra na detecção de ciclo', () => {
    expect(() =>
      sortPlugins([
        { name: 'a', optionalDependsOn: { b: '^1.0.0' } },
        { name: 'b', after: ['a'] },
      ]),
    ).toThrow(PluginCycleError);
  });
});
