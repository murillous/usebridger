import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from './bridger.ts';
import { run } from './openapi.ts';

async function exec(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out, err };
}

// A spec do core descreve a API completa com auth ligada (ADR 0127).
const CORE_PATHS = [
  '/api/health',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/sessions',
  '/api/auth/sessions/{id}',
  '/api/auth/password',
  '/api/auth/invites/accept',
  '/api/users',
  '/api/users/{id}',
  '/api/users/{id}/disable',
  '/api/users/{id}/enable',
  '/api/users/{id}/sessions',
  '/api/users/{id}/reset-password',
  '/api/keys',
  '/api/keys/{id}',
  '/api/connection',
  '/api/connection/pairing-code',
  '/api/connection/logout',
  '/api/events',
  '/api/plugins',
  '/api/plugins/{name}/enable',
  '/api/plugins/{name}/disable',
  '/api/plugins/{name}/config',
  '/api/pseudonyms/{pseudonym}',
];

const PLUGIN_MODULE = `
import { z } from 'zod';
export const plugins = [{
  name: 'demo',
  version: '1.0.0',
  async setup(ctx) {
    ctx.storage.anything();
    ctx.http.api({
      method: 'GET',
      path: '/ping',
      response: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });
  },
}];
`;

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'bridger-openapi-'));
}

describe('bridger openapi', () => {
  it('sem módulo escreve só a spec do core no stdout', async () => {
    const { code, out, err } = await exec([]);
    expect(code).toBe(0);
    expect(err).toEqual([]);
    const doc = JSON.parse(out[0] ?? '');
    expect(doc.openapi).toBe('3.2.0');
    expect(Object.keys(doc.paths)).toEqual(CORE_PATHS);
  });

  it('--out escreve o arquivo e deixa o stdout vazio', async () => {
    const file = join(await tempDir(), 'spec.json');
    const { code, out } = await exec(['--out', file]);
    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8')).paths)).toEqual(CORE_PATHS);
  });

  it('com módulo inclui a rota do plugin sob /api/plugins/<nome>', async () => {
    const file = join(await tempDir(), 'app.mjs');
    // O import de zod resolve a partir do arquivo; ESM puro evita depender da pasta temporária.
    await writeFile(file, PLUGIN_MODULE.replace("import { z } from 'zod';", zodShim()));
    const { code, out, err } = await exec([file]);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(Object.keys(JSON.parse(out[0] ?? '').paths)).toEqual([
      ...CORE_PATHS,
      '/api/plugins/demo/ping',
    ]);
  });

  it('setup que lança sai com 1 e nomeia o plugin', async () => {
    const file = join(await tempDir(), 'app.mjs');
    await writeFile(
      file,
      "export const plugins = [{ name: 'quebrado', version: '1.0.0', setup() { throw new Error('boom'); } }];",
    );
    const { code, err } = await exec([file]);
    expect(code).toBe(1);
    expect(err.join('')).toContain('plugin "quebrado"');
  });

  it('módulo sem `plugins` sai com 1', async () => {
    const file = join(await tempDir(), 'app.mjs');
    await writeFile(file, 'export const outro = 1;');
    const { code, err } = await exec([file]);
    expect(code).toBe(1);
    expect(err.join('')).toContain('plugins');
  });

  it('--help sai com 0', async () => {
    const { code, out } = await exec(['--help']);
    expect(code).toBe(0);
    expect(out.join('')).toContain('Uso: bridger openapi');
  });

  it('plugin que checa ctx.signal.aborted no setup mantém a rota e o teardown vê o abort', async () => {
    const file = join(await tempDir(), 'app.mjs');
    await writeFile(
      file,
      `${zodShim()}
export const plugins = [{
  name: 'sig',
  version: '1.0.0',
  setup(ctx) {
    if (ctx.signal.aborted) return;
    ctx.http.api({ method: 'GET', path: '/x', response: z.object({}), handler: () => ({}) });
  },
  teardown(ctx) { globalThis.__sigAborted = ctx.signal.aborted; },
}];`,
    );
    const { code, out } = await exec([file]);
    expect(code).toBe(0);
    expect(Object.keys(JSON.parse(out[0] ?? '').paths)).toContain('/api/plugins/sig/x');
    expect((globalThis as Record<string, unknown>)['__sigAborted']).toBe(true);
  });

  it('argumento inválido sai com código 1 e mensagem no stderr', async () => {
    for (const argv of [['--nada'], ['a.mjs', 'b.mjs'], ['/nao/existe.mjs']]) {
      const { code, out, err } = await exec(argv);
      expect(code).toBe(1);
      expect(out).toEqual([]);
      expect(err.join('')).not.toBe('');
    }
  });
});

describe('bridger (despacho)', () => {
  async function dispatch(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, { out: (t) => out.push(t), err: (t) => err.push(t) });
    return { code, out, err };
  }

  it('sem comando ou com --help mostra o uso e sai com 0', async () => {
    for (const argv of [[], ['-h'], ['--help']]) {
      const { code, out } = await dispatch(argv);
      expect(code).toBe(0);
      expect(out.join('')).toContain('Uso: bridger <comando>');
    }
  });

  it('comando desconhecido sai com 1 e escreve no stderr', async () => {
    const { code, err } = await dispatch(['nada']);
    expect(code).toBe(1);
    expect(err.join('')).toContain('Comando desconhecido: nada');
  });

  it('openapi é repassado ao comando', async () => {
    expect((await dispatch(['openapi'])).code).toBe(0);
  });
});

// Caminho absoluto do zod do próprio pacote, para o módulo temporário importá-lo.
function zodShim(): string {
  return `import { z } from ${JSON.stringify(import.meta.resolve('zod'))};`;
}
