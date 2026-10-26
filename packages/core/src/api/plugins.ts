// Coleta as operações de API de plugins sem bot, transport nem porta (CLI `bridger openapi`).
// O `setup` é a única porta para `ctx.http.api` (ADR 0003: `createBot` não executa nada), então
// ele roda aqui com um contexto em que só `ctx.http` e `ctx.plugin` são reais.

import { createHttp, sessionHttp } from '#http/server.ts';
import { createNoopLogger } from '#logger/logger.ts';
import type { PluginDefinition } from '#plugin/types.ts';
import type { ApiRoute } from './operation.ts';

// Qualquer outro `ctx.*` vira um no-op encadeável e aguardável: o plugin registra rota sem que o
// kernel toque storage, scheduler ou transport. shortcut: efeito colateral do código do próprio
// plugin (abrir conexão no setup) continua dele; para a spec, registre a API cedo no setup.
function inertContext(real: Record<string, unknown>): unknown {
  const inert: unknown = new Proxy(() => undefined, {
    get: (_target, key) => (key === 'then' || typeof key === 'symbol' ? undefined : inert),
    apply: () => inert,
  });
  return new Proxy(real, { get: (target, key) => (key in target ? target[key as string] : inert) });
}

export async function pluginApiRoutes(
  plugins: readonly PluginDefinition[],
): Promise<readonly ApiRoute[]> {
  // Servidor só como tabela de rotas: sem `attach`/`listen`, nenhuma porta abre.
  const session = sessionHttp(createHttp({ port: 0 }), 'default', createNoopLogger);
  for (const plugin of plugins) {
    const http = session.scope(
      plugin.name,
      () => `/plugins/${plugin.name}`,
      () => undefined,
    );
    await plugin.setup?.(
      inertContext({
        http,
        plugin: { name: plugin.name, version: plugin.version, messages: {} },
      }) as never,
    );
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
