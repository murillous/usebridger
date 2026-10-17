import {
  type HttpHandler,
  type JsonObject,
  type PluginAdmin,
  PluginConfigError,
  type PluginContext,
  PluginHostStateError,
} from '@usebridger/core';
import { sameOrigin } from '#auth.ts';
import { readLimited } from '#body.ts';
import { serializeResult } from '#plugins.ts';

const MAX_CONFIG_BODY = 64 * 1024;

const text = (body: string, status: number): Response => new Response(body, { status });

const toIssues = (error: PluginConfigError) =>
  error.issues.map(({ path, message }) => ({ path, message }));

/**
 * Rotas `/api/config/:plugin` (M5-4.2): view com secrets mascarados + JSON Schema para o
 * formulário, e gravação de overrides. Secret é só leitura aqui: vem do arquivo ou do env.
 */
export function registerConfigRoutes(
  ctx: PluginContext,
  guarded: (handler: HttpHandler) => HttpHandler,
): void {
  // Sem `adminPlugins` não há `ctx.admin`; o aviso fica nas rotas, o resto do dashboard segue.
  // Plugin desconhecido responde 404 aqui, antes do core: um RangeError de `.transform` do
  // plugin não pode ser confundido com ele.
  const withAdmin =
    (
      handler: (
        admin: PluginAdmin,
        name: string,
        ...rest: Parameters<HttpHandler>
      ) => Promise<Response>,
    ): HttpHandler =>
    (request, info) => {
      const admin = ctx.admin;
      if (!admin) {
        return text('config indisponível: inclua "dashboard" em createBot({ adminPlugins })', 503);
      }
      const name = info.params['plugin'] ?? '';
      if (!admin.plugins().some((entry) => entry.name === name)) {
        return text('plugin desconhecido', 404);
      }
      return handler(admin, name, request, info);
    };

  const fail = (what: string, name: string, error: unknown): Response => {
    ctx.log.error(`dashboard: falha ao ${what} config do plugin "${name}"`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return text('erro interno', 500);
  };

  ctx.http.route(
    'GET',
    '/api/config/:plugin',
    guarded(
      withAdmin(async (admin, name) => {
        try {
          const schema = admin.config.jsonSchema(name) ?? null;
          try {
            return Response.json({ view: await admin.config.describe(name), schema });
          } catch (error) {
            // Config atual inválida: é quando o admin mais precisa do formulário para corrigir.
            if (error instanceof PluginConfigError) {
              return Response.json({ view: null, schema, issues: toIssues(error) });
            }
            throw error;
          }
        } catch (error) {
          return fail('ler', name, error);
        }
      }),
    ),
  );

  ctx.http.route(
    'PUT',
    '/api/config/:plugin',
    guarded(
      withAdmin(async (admin, name, request) => {
        if (!sameOrigin(request)) return text('origem inválida', 403);
        // O core recusaria também, mas aqui o texto é claro e o core nem é chamado.
        if (name === ctx.plugin.name) {
          return text(
            'o dashboard não altera a própria config pelo painel; use o arquivo ou o env',
            409,
          );
        }
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
        try {
          const result = await admin.config.setOverrides(name, overrides as JsonObject);
          return Response.json(result === undefined ? null : serializeResult(result));
        } catch (error) {
          if (error instanceof PluginConfigError) {
            // `kind` vem do core: secret recusado vs. valor inválido.
            const secret = error.issues.some((issue) => issue.kind === 'secret');
            return Response.json(
              { error: secret ? 'secret' : 'invalid', issues: toIssues(error) },
              { status: 400 },
            );
          }
          // O override é gravado antes do reload: falha do reload deixa o salvo.
          if (error instanceof PluginHostStateError) {
            return text(
              `${error.message.slice(0, 300)} (se a config era válida, ficou salva, mas o reload falhou)`,
              409,
            );
          }
          ctx.log.error(`dashboard: falha ao gravar config do plugin "${name}"`, {
            error: error instanceof Error ? error.message : String(error),
          });
          return text('erro interno (o override pode ter sido salvo sem o reload)', 500);
        }
      }),
    ),
  );
}
