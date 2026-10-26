import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from './openapi.ts';

async function exec(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out, err };
}

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
    expect(Object.keys(doc.paths)).toEqual(['/api/health']);
  });

  it('--out escreve o arquivo e deixa o stdout vazio', async () => {
    const file = join(await tempDir(), 'spec.json');
    const { code, out } = await exec(['--out', file]);
    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8')).paths)).toEqual(['/api/health']);
  });

  it('com módulo inclui a rota do plugin sob /api/plugins/<nome>', async () => {
    const file = join(await tempDir(), 'app.mjs');
    // O import de zod resolve a partir do arquivo; ESM puro evita depender da pasta temporária.
    await writeFile(file, PLUGIN_MODULE.replace("import { z } from 'zod';", zodShim()));
    const { code, out, err } = await exec([file]);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(Object.keys(JSON.parse(out[0] ?? '').paths)).toEqual([
      '/api/health',
      '/api/plugins/demo/ping',
    ]);
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

// Caminho absoluto do zod do próprio pacote, para o módulo temporário importá-lo.
function zodShim(): string {
  return `import { z } from ${JSON.stringify(import.meta.resolve('zod'))};`;
}
