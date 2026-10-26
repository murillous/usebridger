// Coleta as operações de API de plugins sem bot, transport nem porta (CLI `bridger openapi`).
// `ctx.http.api` só existe dentro do `setup`, então ele roda aqui com um contexto em que só
// `ctx.http`, `ctx.plugin`, `ctx.signal` e `ctx.config` (defaults do schema) são reais. Importar
// o módulo do app não tem efeito colateral (ADR 0003), o que permite chegar até aqui.

import { createHttp, sessionHttp } from '#http/server.ts';
import { createNoopLogger } from '#logger/logger.ts';
import { DEFAULT_SETUP_TIMEOUT_MS } from '#plugin/host.ts';
import type { PluginDefinition } from '#plugin/types.ts';
import type { ApiRoute } from './operation.ts';

// Qualquer outro `ctx.*` vira um no-op encadeável e aguardável: o plugin registra rota sem que o
// kernel toque storage, scheduler ou transport. shortcut: efeito colateral do código do próprio
// plugin (abrir conexão no setup) continua dele; para a spec, registre a API cedo no setup.
function inertContext(real: Record<string, unknown>, config?: unknown): unknown {
  const inert: unknown = new Proxy(() => undefined, {
    get: (_target, key) => (key === 'then' || typeof key === 'symbol' ? undefined : inert),
    apply: () => inert,
  });
  const all: Record<string, unknown> = { ...real, config: config ?? inert };
  return new Proxy(all, { get: (target, key) => (key in target ? target[key as string] : inert) });
}

/** Defaults do schema de config; com campo obrigatório, fica `undefined` (vira o no-op). */
function defaultConfig(plugin: PluginDefinition): unknown {
  const parsed = plugin.config?.safeParse({});
  return parsed?.success ? parsed.data : undefined;
}

async function withDeadline<T>(work: () => Promise<T>, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`excedeu ${DEFAULT_SETUP_TIMEOUT_MS} ms`)),
      DEFAULT_SETUP_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work(), timeout]);
  } catch (cause) {
    throw new Error(`plugin "${name}": setup falhou ao coletar a API`, { cause });
  } finally {
    clearTimeout(timer);
  }
}

export async function pluginApiRoutes(
  plugins: readonly PluginDefinition[],
): Promise<readonly ApiRoute[]> {
  // Servidor só como tabela de rotas: sem `attach`/`listen`, nenhuma porta abre.
  const session = sessionHttp(
    createHttp({ port: 0, hostname: '127.0.0.1' }),
    'default',
    createNoopLogger,
  );
  for (const plugin of plugins) {
    const http = session.scope(
      plugin.name,
      () => `/plugins/${plugin.name}`,
      () => undefined,
    );
    // Signal real que não aborta durante o `setup`: `if (ctx.signal.aborted) return` não some com
    // a rota. Abortar no fim roda a limpeza que o plugin amarrou a ele (ADR 0029).
    const controller = new AbortController();
    const ctx = inertContext(
      {
        http,
        signal: controller.signal,
        plugin: { name: plugin.name, version: plugin.version, messages: plugin.messages ?? {} },
      },
      defaultConfig(plugin),
    ) as never;
    try {
      // Lambda async: um `setup` síncrono que lança também passa pelo deadline e ganha contexto.
      await withDeadline(async () => plugin.setup?.(ctx), plugin.name);
    } finally {
      controller.abort();
      await withDeadline(async () => plugin.teardown?.(ctx), plugin.name);
    }
  }
  const routes: ApiRoute[] = [];
  for (const entry of session.entries()) {
    if (entry.api) {
      routes.push({
        path: `${entry.base()}${entry.path === '/' ? '' : entry.path}`,
        operation: entry.api,
      });
    }
  }
  return routes;
}
