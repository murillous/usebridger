import type {
  HttpHandler,
  Logger,
  PluginAdmin,
  PluginChangeResult,
  PluginLifecycleError,
  PluginReportEntry,
} from '@usebridger/core';
import { sameOrigin } from '#auth.ts';

const ACTIONS = ['enable', 'disable', 'reload'] as const;

const NO_ADMIN =
  'controle de plugins indisponível: ponha "dashboard" em adminPlugins no createBot ({ adminPlugins: ["dashboard"] })';

/** Só o necessário do erro de lifecycle: o objeto cru pode carregar `cause` com dados sensíveis. */
const lifecycle = (error: PluginLifecycleError) => ({
  plugin: error.plugin,
  phase: error.phase,
  timedOut: error.timedOut,
  message: error.message.slice(0, 300),
});

/** Linha da tabela em JSON seguro: o `PluginLifecycleError` de `setup-failed` vira `{ plugin, phase, timedOut, message }`. */
function serializeEntry(entry: PluginReportEntry) {
  if (entry.status === 'loaded') return entry;
  const { reason } = entry;
  return {
    ...entry,
    reason: reason.kind === 'setup-failed' ? { ...reason, error: lifecycle(reason.error) } : reason,
  };
}

function serializeResult(result: PluginChangeResult) {
  return {
    plugin: serializeEntry(result.plugin),
    dependents: result.dependents.map(serializeEntry),
    teardownErrors: result.teardownErrors.map(lifecycle),
  };
}

/** Rotas de controle de plugins (ADR 0111). Sem `admin` (dashboard fora de `adminPlugins`) respondem 503. */
export function registerPluginRoutes(
  http: { route(method: 'GET' | 'POST', path: string, handler: HttpHandler): void },
  admin: PluginAdmin | undefined,
  log: Logger,
  guarded: (handler: HttpHandler) => HttpHandler,
): void {
  if (admin === undefined) log.warn(`dashboard: ${NO_ADMIN}`);
  const unavailable = () => new Response(NO_ADMIN, { status: 503 });
  const plugins = admin?.plugins;

  http.route(
    'GET',
    '/api/plugins',
    guarded(() => (plugins ? Response.json(plugins().map(serializeEntry)) : unavailable())),
  );

  for (const action of ACTIONS) {
    http.route(
      'POST',
      `/api/plugins/:name/${action}`,
      guarded(async (request, info) => {
        // Cookie SameSite=Strict já protege; o Origin é a segunda barreira contra CSRF.
        if (!sameOrigin(request)) return new Response('origem inválida', { status: 403 });
        if (!plugins) return unavailable();
        const name = info.params['name'] ?? '';
        if (!plugins().some((entry) => entry.name === name)) {
          return new Response('plugin desconhecido', { status: 404 });
        }
        try {
          return Response.json(serializeResult(await plugins[action](name)));
        } catch (error) {
          // O core não exporta a classe; o `name` identifica estado inválido (self, ignorado, host parado).
          if (error instanceof Error && error.name === 'PluginHostStateError') {
            return new Response(error.message.slice(0, 300), { status: 409 });
          }
          ctxError(log, action, name, error);
          return new Response('erro interno', { status: 500 });
        }
      }),
    );
  }
}

function ctxError(log: Logger, action: string, name: string, error: unknown): void {
  log.error(`dashboard: falha em ${action} do plugin "${name}"`, {
    error: error instanceof Error ? error.message : String(error),
  });
}
