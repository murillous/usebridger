import {
  type HttpHandler,
  type Logger,
  type PluginAdmin,
  type PluginChangeResult,
  PluginHostStateError,
  type PluginLifecycleError,
  type PluginReportEntry,
} from '@usebridger/core';
import { sameOrigin } from '#auth.ts';

const ACTIONS = ['enable', 'disable', 'reload'] as const;

const NO_ADMIN =
  'controle de plugins indisponível: ponha "dashboard" em adminPlugins no createBot ({ adminPlugins: ["dashboard"] })';

/**
 * Texto da causa (`Nome: mensagem`), nunca o objeto: pode carregar dados sensíveis. O `admin` do
 * core já passa o erro pelo redator de secrets, então a mensagem chega censurada; sem stack.
 */
const causeText = (cause: unknown): string | undefined =>
  cause instanceof Error ? `${cause.name}: ${cause.message}`.slice(0, 300) : undefined;

/** Só o necessário do erro de lifecycle: o objeto cru pode carregar `cause` com dados sensíveis. */
const lifecycle = (error: PluginLifecycleError) => ({
  plugin: error.plugin,
  phase: error.phase,
  timedOut: error.timedOut,
  message: error.message.slice(0, 300),
});

/** Linha da tabela em JSON seguro: o `PluginLifecycleError` de `setup-failed` vira `{ plugin, phase, timedOut, message }` e a `reason` ganha `causeMessage` (texto; nunca o objeto `cause` cru). */
function serializeEntry(entry: PluginReportEntry) {
  if (entry.status === 'loaded') return entry;
  const { reason } = entry;
  if (reason.kind !== 'setup-failed') return entry;
  const causeMessage = causeText(reason.error.cause);
  return {
    ...entry,
    reason: {
      ...reason,
      error: lifecycle(reason.error),
      ...(causeMessage !== undefined && { causeMessage }),
    },
  };
}

export function serializeResult(result: PluginChangeResult): object {
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

  // Separada da lista, que é um array puro; o horário vem do core e não muda com o reload.
  http.route(
    'GET',
    '/api/plugins/boot',
    guarded(() => (plugins ? Response.json({ bootedAt: plugins.bootedAt }) : unavailable())),
  );

  http.route(
    'GET',
    '/api/plugins',
    guarded(() => {
      if (!plugins) return unavailable();
      const durations = plugins.setupDurations();
      return Response.json(
        plugins().map((entry) => {
          const setupMs = durations[entry.name];
          return { ...serializeEntry(entry), ...(setupMs !== undefined && { setupMs }) };
        }),
      );
    }),
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
          // Estado inválido (self, ignorado, host parado): a mensagem é do core e segura.
          if (error instanceof PluginHostStateError) {
            return new Response(error.message.slice(0, 300), { status: 409 });
          }
          log.error(`dashboard: falha em ${action} do plugin "${name}"`, {
            error,
          });
          return new Response('erro interno', { status: 500 });
        }
      }),
    );
  }
}
