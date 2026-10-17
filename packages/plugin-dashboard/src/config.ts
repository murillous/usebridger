import { type HttpHandler, PluginConfigError, type PluginContext } from '@usebridger/core';
import { sameOrigin } from '#auth.ts';
import { readLimited } from '#body.ts';

const MAX_CONFIG_BODY = 64 * 1024;

const text = (body: string, status: number): Response => new Response(body, { status });

// Erro do reload não sai cru (stack, cause): só nome e mensagem.
const safe = (_key: string, value: unknown): unknown =>
  value instanceof Error ? { name: value.name, message: value.message } : value;

/** 400 com caminho e mensagem de cada problema, para o form mostrar junto do campo. */
function issues(error: PluginConfigError): Response {
  const list = error.issues.map(({ path, message }) => ({ path, message }));
  const secret = error.issues.some(
    (i) => i.source === 'override' && i.message.startsWith('campo secreto'),
  );
  return Response.json({ error: secret ? 'secret' : 'invalid', issues: list }, { status: 400 });
}

/**
 * Rotas `/api/config/:plugin` (M5-4.2): view com secrets mascarados + JSON Schema para o
 * formulário, e gravação de overrides. Secret é só leitura aqui: vem do arquivo ou do env.
 */
export function registerConfigRoutes(
  ctx: PluginContext,
  guarded: (handler: HttpHandler) => HttpHandler,
): void {
  // Sem `adminPlugins` não há `ctx.admin`; o aviso fica nas rotas, o resto do dashboard segue.
  const withAdmin =
    (handler: HttpHandler): HttpHandler =>
    (request, info) =>
      ctx.admin
        ? handler(request, info)
        : text('config indisponível: inclua "dashboard" em createBot({ adminPlugins })', 503);

  ctx.http.route(
    'GET',
    '/api/config/:plugin',
    guarded(
      withAdmin(async (_request, { params }) => {
        const name = params['plugin'] ?? '';
        try {
          // `describe` lança RangeError para plugin desconhecido.
          const view = await ctx.admin?.config.describe(name);
          return Response.json({ view, schema: ctx.admin?.config.jsonSchema(name) ?? null });
        } catch (error) {
          if (error instanceof RangeError) return text('plugin desconhecido', 404);
          if (error instanceof PluginConfigError) return issues(error);
          ctx.log.error('dashboard: falha ao ler config do plugin', { plugin: name, error });
          return text('erro interno', 500);
        }
      }),
    ),
  );

  ctx.http.route(
    'PUT',
    '/api/config/:plugin',
    guarded(
      withAdmin(async (request, { params }) => {
        if (!sameOrigin(request)) return text('origem inválida', 403);
        const body = await readLimited(request, MAX_CONFIG_BODY);
        if (body === undefined) return text('corpo grande demais', 413);
        let overrides: unknown;
        try {
          overrides = JSON.parse(body);
        } catch {
          return text('JSON inválido', 400);
        }
        if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
          return text('o corpo deve ser um objeto JSON', 400);
        }
        const name = params['plugin'] ?? '';
        try {
          const result = await ctx.admin?.config.setOverrides(name, overrides as never);
          return new Response(JSON.stringify(result ?? null, safe), {
            headers: { 'content-type': 'application/json' },
          });
        } catch (error) {
          if (error instanceof RangeError) return text('plugin desconhecido', 404);
          if (error instanceof PluginConfigError) return issues(error);
          // O core não exporta `PluginHostStateError` (lacuna do core): compara pelo `name`.
          if (error instanceof Error && error.name === 'PluginHostStateError') {
            return text(error.message, 409);
          }
          ctx.log.error('dashboard: falha ao gravar config do plugin', { plugin: name, error });
          return text('erro interno', 500);
        }
      }),
    ),
  );
}
