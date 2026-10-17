import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { HttpHandler } from '@usebridger/core';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const NOT_FOUND = (): Response => new Response('não encontrado', { status: 404 });

/**
 * Handler do app web (build do Vite em `dir`). Qualquer GET que não seja arquivo cai no
 * `index.html` (SPA), menos `api/*`, que é do plugin e responde 404 se a rota não existe.
 * O `index.html` ganha `<base href>` do `basePath`: os caminhos do app são relativos a ele e
 * funcionam em `/plugins/dashboard` e em `/sessions/<s>/plugins/dashboard`, com ou sem barra final.
 */
export function createStaticHandler(dir: string, basePath: string): HttpHandler {
  const root = resolve(dir);
  const base = `${basePath}/`;

  const load = async (file: string): Promise<Buffer | undefined> => {
    try {
      return await readFile(file);
    } catch (error) {
      // Só "não existe / é pasta" vira fallback; qualquer outro erro (permissão, I/O) sobe como 500.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return undefined;
      throw error;
    }
  };

  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname !== basePath && !pathname.startsWith(base)) return NOT_FOUND();
    let rel: string;
    try {
      rel = decodeURIComponent(pathname.slice(base.length));
    } catch {
      return NOT_FOUND();
    }
    if (rel === 'api' || rel.startsWith('api/')) return NOT_FOUND();
    // Traversal: nada com NUL, barra invertida ou ".." sai da pasta do app.
    if (rel.includes('\0') || rel.includes('\\') || rel.split('/').includes('..')) {
      return NOT_FOUND();
    }
    const file = resolve(join(root, rel));
    if (rel !== '' && file.startsWith(root + sep)) {
      const body = await load(file);
      if (body !== undefined) {
        const type = TYPES[extname(file)] ?? 'application/octet-stream';
        // Só `assets/` tem hash no nome (Vite): cache longo é seguro ali e só ali.
        const cache = rel.startsWith('assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache';
        return new Response(new Uint8Array(body), {
          headers: { 'content-type': type, 'cache-control': cache },
        });
      }
      // Pedido com extensão que não existe é asset faltando, não rota do SPA.
      if (extname(rel) !== '') return NOT_FOUND();
    }
    const html = await load(join(root, 'index.html'));
    if (html === undefined) return NOT_FOUND();
    const text = html.toString('utf8').replace('<head>', `<head><base href="${base}" />`);
    return new Response(text, {
      headers: { 'content-type': TYPES['.html'] ?? 'text/html', 'cache-control': 'no-cache' },
    });
  };
}
