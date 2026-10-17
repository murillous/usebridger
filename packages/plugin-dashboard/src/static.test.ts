import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaticHandler } from '#static.ts';

const BASE = '/plugins/dashboard';
let dir: string;
let outside: string;
let handle: ReturnType<typeof createStaticHandler>;

const get = (path: string): Promise<Response> =>
  Promise.resolve(handle(new Request(`http://x${path}`), { params: {} }));

beforeAll(() => {
  const parent = mkdtempSync(join(tmpdir(), 'dash-static-'));
  outside = join(parent, 'segredo.txt');
  writeFileSync(outside, 'segredo');
  dir = join(parent, 'web');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<html><head></head><body>app</body></html>');
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
  handle = createStaticHandler(dir, BASE);
});

afterAll(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

describe('createStaticHandler', () => {
  it('serve o index.html com <base href> do basePath, com e sem barra final', async () => {
    for (const path of [BASE, `${BASE}/`]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toContain(`<base href="${BASE}/" />`);
    }
  });

  it('serve assets com o content-type certo e cache longo só em assets/', async () => {
    const asset = await get(`${BASE}/assets/app-abc123.js`);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    const icon = await get(`${BASE}/favicon.svg`);
    expect(icon.headers.get('content-type')).toBe('image/svg+xml');
    expect(icon.headers.get('cache-control')).toBe('no-cache');
  });

  it('cai no index.html para rota do SPA, mas 404 para arquivo e api/ inexistentes', async () => {
    expect(await (await get(`${BASE}/config`)).text()).toContain('app');
    expect((await get(`${BASE}/assets/nao-existe.js`)).status).toBe(404);
    expect((await get(`${BASE}/api/nada`)).status).toBe(404);
    expect((await get('/outro/caminho')).status).toBe(404);
  });

  it('não serve nada fora da pasta do app (path traversal)', async () => {
    for (const path of [
      `${BASE}/../segredo.txt`,
      `${BASE}/%2e%2e/segredo.txt`,
      `${BASE}/assets/..%2f..%2fsegredo.txt`,
      `${BASE}/..%5csegredo.txt`,
      `${BASE}/%00`,
      `${BASE}/%`,
    ]) {
      const res = await get(path);
      expect(await res.text(), path).not.toContain('segredo');
    }
    expect((await get(`${BASE}/%2e%2e/segredo.txt`)).status).toBe(404);
  });
});
