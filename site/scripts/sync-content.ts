import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix } from 'node:path';

// Também lido pelo astro.config.mjs: o `base` do GitHub Pages precisa ser o mesmo nos links
// reescritos aqui e nas rotas do site.
export const BASE = '/usebridger';
const REPO = 'https://github.com/murillous/usebridger';

export interface Entry {
  /** Caminho do Markdown de origem, relativo à raiz do repositório (separador `/`). */
  readonly source: string;
  /** Destino dentro de `src/content/docs/`. */
  readonly out: string;
}

/** Rota do site (sem barras nas pontas) de um destino: `guias/index.md` vira `guias`. */
function routeOf(out: string): string {
  return out.replace(/\.md$/, '').replace(/(^|\/)index$/, '');
}

/** O README.md de cada pasta vira o index dela no site. */
function outName(dir: string, file: string): string {
  return `${dir}/${file === 'README.md' ? 'index.md' : file}`;
}

function mdFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
}

/** O que vai para o site e para onde (ver a decisão no issue #91). */
export function collectEntries(root: string): Entry[] {
  const entries: Entry[] = [];
  const add = (srcDir: string, outDir: string) => {
    for (const file of mdFiles(join(root, srcDir))) {
      entries.push({ source: `${srcDir}/${file}`, out: outName(outDir, file) });
    }
  };
  add('docs/guias', 'guias');
  add('docs/adr', 'decisoes');
  for (const pkg of readdirSync(join(root, 'packages'))) {
    add(`packages/${pkg}/docs`, `pacotes/${pkg}`);
  }
  entries.push({ source: 'docs/release.md', out: 'contribuindo/release.md' });
  return entries;
}

/**
 * Tira o primeiro `# H1` (fora de bloco de código) do corpo: o Starlight renderiza o `title` do
 * frontmatter como H1, e manter os dois duplicaria o título na página.
 */
export function extractTitle(markdown: string): { title: string | undefined; body: string } {
  const lines = markdown.split('\n');
  let fenced = false;
  for (const [i, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const match = fenced ? null : /^# +(.+?) *$/.exec(line);
    if (match?.[1]) {
      // O title do Starlight é texto puro: crases ficariam literais.
      const title = match[1].replaceAll('`', '');
      return { title, body: [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n').trimStart() };
    }
  }
  return { title: undefined, body: markdown };
}

export interface LinkContext {
  /** Origem -> rota do site, só dos arquivos sincronizados. */
  readonly routes: ReadonlyMap<string, string>;
  /** Tipo do caminho (relativo à raiz do repo) no disco, para links que saem do site. */
  readonly kind: (path: string) => 'file' | 'dir' | undefined;
}

// O primeiro grupo casa trechos de código inline, que passam sem reescrita (ex.: `[a](url)`).
const INLINE_LINK = /(`[^`]*`)|\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g;

function rewriteTarget(target: string, source: string, ctx: LinkContext): string {
  // Absolutos, âncoras da própria página e caminhos a partir da raiz ficam como estão.
  if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return target;
  const hashAt = target.indexOf('#');
  const path = hashAt === -1 ? target : target.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : target.slice(hashAt);
  const resolved = posix.normalize(posix.join(posix.dirname(source), path));
  const route = ctx.routes.get(resolved);
  if (route !== undefined) return `${BASE}/${route}/${hash}`.replace('//', '/');
  const kind = ctx.kind(resolved);
  // Link para arquivo que não existe está errado na origem: falhar aqui aponta o arquivo certo.
  if (!kind) throw new Error(`${source}: o link '${target}' aponta para um caminho inexistente`);
  return `${REPO}/${kind === 'dir' ? 'tree' : 'blob'}/main/${resolved.replace(/\/$/, '')}${hash}`;
}

/** Reescreve os links relativos de um Markdown sincronizado (blocos de código ficam intactos). */
export function rewriteLinks(body: string, source: string, ctx: LinkContext): string {
  let fenced = false;
  return body
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return line.replace(
        INLINE_LINK,
        (match, code: string | undefined, target: string, title: string) =>
          code ? match : `](${rewriteTarget(target, source, ctx)}${title})`,
      );
    })
    .join('\n');
}

export function syncContent(root: string, contentDir: string): void {
  const entries = collectEntries(root);
  const routes = new Map(entries.map((e) => [e.source, routeOf(e.out)]));
  const ctx: LinkContext = {
    routes,
    kind: (path) => {
      const full = join(root, path);
      return existsSync(full) ? (statSync(full).isDirectory() ? 'dir' : 'file') : undefined;
    },
  };

  // Limpa só o que é gerado: páginas escritas à mão (index.mdx, comecando/...) ficam.
  for (const dir of ['guias', 'pacotes', 'decisoes']) {
    rmSync(join(contentDir, dir), { recursive: true, force: true });
  }
  for (const entry of entries) rmSync(join(contentDir, entry.out), { force: true });

  for (const { source, out } of entries) {
    const { title, body } = extractTitle(readFileSync(join(root, source), 'utf8'));
    const frontmatter = [
      '---',
      // JSON é string YAML válida (aspas e acentos escapados).
      `title: ${JSON.stringify(title ?? out)}`,
      // develop, não main: os PRs vão para a develop (ADR 0085) e a main só recebe o release.
      `editUrl: ${REPO}/edit/develop/${source}`,
      '---',
      '',
    ].join('\n');
    const target = join(contentDir, out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, frontmatter + rewriteLinks(body, source, ctx));
  }
  console.log(`site: ${entries.length} páginas sincronizadas`);
}

if (import.meta.main) {
  syncContent(
    join(import.meta.dirname, '..', '..'),
    join(import.meta.dirname, '..', 'src', 'content', 'docs'),
  );
}
