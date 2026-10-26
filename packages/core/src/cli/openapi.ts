// `bridger openapi [módulo] [--out <arquivo>]`: escreve a spec OpenAPI do core (e dos plugins do
// módulo) sem conectar transport nem abrir porta, para o frontend gerar tipos no build (ADR 0125).

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { coreApiRoutes } from '#api/core.ts';
import { createOpenApiDocument } from '#api/openapi.ts';
import { pluginApiRoutes } from '#api/plugins.ts';
import type { PluginDefinition } from '#plugin/types.ts';

export const USAGE = `Uso: bridger openapi [módulo] [--out <arquivo>]

Escreve a spec OpenAPI 3.2 da API (JSON) no stdout, ou em --out. Sem módulo, só a do core.
O módulo é um arquivo do app (.ts, .mjs, .js) com \`export const plugins = [...]\`: as operações
que esses plugins registram por ctx.http.api entram na spec. Nada conecta e nenhuma porta abre.`;

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** Roda o comando e devolve o código de saída. */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${USAGE}`);
    return 1;
  }
  if (parsed.values.help) {
    io.out(USAGE);
    return 0;
  }
  if (parsed.positionals.length > 1) {
    io.err(USAGE);
    return 1;
  }
  try {
    const [file] = parsed.positionals;
    const routes = [...(await coreApiRoutes())];
    if (file !== undefined) routes.push(...(await pluginApiRoutes(await loadPlugins(file))));
    const json = JSON.stringify(await createOpenApiDocument(routes), null, 2);
    if (parsed.values.out === undefined) io.out(json);
    else await writeFile(parsed.values.out, `${json}\n`);
    return 0;
  } catch (error) {
    io.err(`bridger openapi: ${(error as Error).message}`);
    return 1;
  }
}

async function loadPlugins(file: string): Promise<readonly PluginDefinition[]> {
  const mod = (await import(pathToFileURL(resolve(file)).href)) as { plugins?: unknown };
  if (!Array.isArray(mod.plugins)) {
    throw new Error(`${file} precisa exportar \`plugins\` (array de plugins)`);
  }
  return mod.plugins as PluginDefinition[];
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' }, out: { type: 'string', short: 'o' } },
  });
}
