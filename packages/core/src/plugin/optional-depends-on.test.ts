// `optionalDependsOn` (#84, ADR 0099): ordena como o `after` e é validado no manifesto.

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
  it('aceita uma lista de nomes de plugin', () => {
    expect(manifestIssues({ ...valid, optionalDependsOn: ['sticker'] })).toEqual([]);
  });

  it.each([
    ['que não é lista', { optionalDependsOn: 'sticker' }, /optionalDependsOn deve ser uma lista/],
    ['com nome inválido', { optionalDependsOn: ['Sticker'] }, /optionalDependsOn: item/],
    ['em si mesmo', { optionalDependsOn: ['download'] }, /optionalDependsOn não pode citar/],
    [
      'repetindo o dependsOn',
      { dependsOn: { sticker: '^1.0.0' }, optionalDependsOn: ['sticker'] },
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
        { name: 'download', optionalDependsOn: ['sticker', 'fantasma'] },
        { name: 'sticker' },
      ]),
    ).toEqual(['sticker', 'download']);
  });

  it('entra na detecção de ciclo', () => {
    expect(() =>
      sortPlugins([
        { name: 'a', optionalDependsOn: ['b'] },
        { name: 'b', after: ['a'] },
      ]),
    ).toThrow(PluginCycleError);
  });
});
