import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { extractTitle, type LinkContext, rewriteLinks, syncContent } from './sync-content.ts';

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

it('syncContent limpa só o gerado e transforma README.md em index.md', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sync-content-'));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  try {
    const root = join(tmp, 'repo');
    const site = join(tmp, 'site');
    write(join(root, 'docs/guias/README.md'), '# Guias\n\nTexto.\n');
    write(join(root, 'docs/release.md'), '# Release\n');
    mkdirSync(join(root, 'packages'));
    write(join(site, 'guias/velho.md'), 'sobra de uma execução anterior');
    write(join(site, 'comecando/primeiro-bot.mdx'), 'à mão');
    write(join(site, 'index.mdx'), 'à mão');

    syncContent(root, site);

    expect(readFileSync(join(site, 'comecando/primeiro-bot.mdx'), 'utf8')).toBe('à mão');
    expect(readFileSync(join(site, 'index.mdx'), 'utf8')).toBe('à mão');
    expect(existsSync(join(site, 'guias/velho.md'))).toBe(false);
    const index = readFileSync(join(site, 'guias/index.md'), 'utf8');
    expect(index).toContain('title: "Guias"');
    expect(index).toContain('/edit/develop/docs/guias/README.md');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
