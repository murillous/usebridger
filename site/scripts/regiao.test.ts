import { expect, it } from 'vitest';
import { extrairRegiao } from './regiao.ts';

const arquivo = [
  'import x from "x";',
  '// #region a',
  '  if (x) {',
  '',
  '    f();',
  '  }',
  '// #endregion a',
  '// #region b',
  'g();',
  '// #endregion b',
].join('\n');

it('extrai só a região pedida, sem as marcas e sem o recuo comum', () => {
  expect(extrairRegiao(arquivo, 'a')).toBe('if (x) {\n\n  f();\n}');
  expect(extrairRegiao(arquivo, 'b')).toBe('g();');
});

it('falha se a região não existe ou não fecha', () => {
  expect(() => extrairRegiao(arquivo, 'c')).toThrow('Região "c"');
  expect(() => extrairRegiao('// #region z\nx', 'z')).toThrow('Região "z"');
});
