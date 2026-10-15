import { expect, it } from 'vitest';
import { extractTitle, type LinkContext, rewriteLinks } from './sync-content.ts';

const ctx: LinkContext = {
  routes: new Map([
    ['docs/guias/comandos.md', 'guias/comandos'],
    ['docs/guias/README.md', 'guias'],
  ]),
  kind: (path) => {
    if (path === 'packages/core/src/') return 'dir';
    return path === 'packages/core/src/x.ts' ? 'file' : undefined;
  },
};

it('extrai o primeiro H1 como título e o remove do corpo', () => {
  expect(extractTitle('# Comandos `x`\n\ntexto\n\n# Outro\n')).toEqual({
    title: 'Comandos x',
    body: 'texto\n\n# Outro\n',
  });
});

it('ignora # dentro de bloco de código e aceita arquivo sem H1', () => {
  const md = '```sh\n# comentário\n```\n';
  expect(extractTitle(md)).toEqual({ title: undefined, body: md });
});

it('reescreve link entre arquivos sincronizados para a rota com o base, preservando âncora', () => {
  const md = 'veja [x](comandos.md#args) e [y](./README.md)';
  expect(rewriteLinks(md, 'docs/guias/storage.md', ctx)).toBe(
    'veja [x](/usebridger/guias/comandos/#args) e [y](/usebridger/guias/)',
  );
});

it('manda link para fora do conteúdo sincronizado ao GitHub (arquivo e pasta)', () => {
  const md = '[a](../../packages/core/src/x.ts#L3) [b](../../packages/core/src/)';
  expect(rewriteLinks(md, 'docs/guias/storage.md', ctx)).toBe(
    '[a](https://github.com/murillous/usebridger/blob/main/packages/core/src/x.ts#L3) ' +
      '[b](https://github.com/murillous/usebridger/tree/main/packages/core/src)',
  );
});

it('deixa intactos links absolutos, âncoras e código', () => {
  const md = '[a](https://x.dev) [b](#topo) `[d](comandos.md)`\n```\n[c](comandos.md)\n```';
  expect(rewriteLinks(md, 'docs/guias/storage.md', ctx)).toBe(md);
});

it('falha em link para caminho inexistente', () => {
  expect(() => rewriteLinks('[a](nada.ts)', 'docs/guias/storage.md', ctx)).toThrow(/inexistente/);
});
