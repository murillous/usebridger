import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LLMS_SETS,
  type LlmsSet,
  matchesPage,
  PACKAGES,
  pagesOf,
  renderIndex,
  renderSetHeader,
  setUrl,
} from './llms.ts';
import { collectEntries, routeOf } from './sync-content.ts';

const root = join(import.meta.dirname, '..', '..');
const site = 'https://murillous.github.io/usebridger/';

// Ids de página do site: os sincronizados do repo e os escritos à mão em comecando/.
const synced = collectEntries(root).map((e) => routeOf(e.out));
const handwritten = readdirSync(join(root, 'site/src/content/docs/comecando')).map(
  (f) => `comecando/${f.replace(/\.mdx?$/, '')}`,
);
const pageIds = [...synced, ...handwritten];

describe('conjuntos do llms.txt', () => {
  it('cada pacote com docs tem o seu conjunto', () => {
    const withDocs = readdirSync(join(root, 'packages')).filter((pkg) =>
      synced.some((id) => id === `pacotes/${pkg}`),
    );
    expect(PACKAGES.map((s) => s.id).sort()).toEqual(withDocs.map((p) => `pacotes/${p}`).sort());
  });

  it('todo padrão de página casa com alguma página do site', () => {
    const orphans = LLMS_SETS.flatMap((s) =>
      s.pages.filter((p) => !pageIds.some((id) => matchesPage(p, id))).map((p) => `${s.id}: ${p}`),
    );
    expect(orphans).toEqual([]);
  });

  it('toda página de guia, conceito, pacote e começando está em algum conjunto', () => {
    // Fora: o índice dos conceitos (só links) e as páginas de quem contribui com o monorepo.
    const outside = new Set(['conceitos', 'conceitos/contribuindo', 'contribuindo/release']);
    const missing = pageIds.filter(
      (id) => !outside.has(id) && !LLMS_SETS.some((s) => s.pages.some((p) => matchesPage(p, id))),
    );
    expect(missing).toEqual([]);
  });

  it('relacionados existem, sem repetir nem apontar para si', () => {
    const ids = new Set(LLMS_SETS.map((s) => s.id));
    expect(ids.size).toBe(LLMS_SETS.length);
    for (const set of LLMS_SETS) {
      expect(set.related.length, set.id).toBeGreaterThan(0);
      expect(
        set.related.filter((id) => !ids.has(id) || id === set.id),
        set.id,
      ).toEqual([]);
    }
  });
});

it('`pasta/**` casa a pasta e o que está abaixo, sem pegar a vizinha de prefixo igual', () => {
  expect(matchesPage('pacotes/testing/**', 'pacotes/testing')).toBe(true);
  expect(matchesPage('pacotes/testing/**', 'pacotes/testing/x')).toBe(true);
  expect(matchesPage('pacotes/core/**', 'pacotes/core-extra')).toBe(false);
  expect(matchesPage('guias/config', 'guias/config-x')).toBe(false);
});

it('pagesOf segue a ordem dos padrões e não repete página', () => {
  const set: LlmsSet = {
    id: 'topicos/x',
    title: 'X',
    description: 'x',
    pages: ['guias/b', 'pacotes/p/**', 'pacotes/p/a'],
    related: [],
  };
  expect(pagesOf(set, ['pacotes/p/b', 'pacotes/p/a', 'guias/b', 'pacotes/p', 'guias/c'])).toEqual([
    'guias/b',
    'pacotes/p',
    'pacotes/p/a',
    'pacotes/p/b',
  ]);
});

it('o topo do conjunto aponta para os relacionados, o índice e os links extras', () => {
  const api = LLMS_SETS.find((s) => s.id === 'topicos/api-http') as LlmsSet;
  const header = renderSetHeader(api, site);
  expect(header).toContain('# Bridger: API HTTP e painéis');
  expect(header).toContain(`(${site}llms.txt)`.slice(1, -1));
  expect(header).toContain(`(${setUrl(site, 'topicos/config')})`);
  expect(header).toContain(`(${site}openapi.json)`);
});

it('o índice lista todos os conjuntos e a spec OpenAPI', () => {
  const index = renderIndex(site);
  for (const set of LLMS_SETS) expect(index).toContain(`(${site}llms/${set.id}.txt)`);
  expect(index).toContain(`(${site}openapi.json)`);
  expect(index).toMatch(/## Tópicos[\s\S]*## Pacotes[\s\S]*## API HTTP/);
});
