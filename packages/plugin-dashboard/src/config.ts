import {
  ContextExpiredError,
  type HttpHandler,
  type JsonObject,
  type JsonValue,
  type PluginAdmin,
  type PluginChangeResult,
  PluginConfigError,
  type PluginContext,
  PluginHostStateError,
} from '@usebridger/core';
import { sameOrigin } from '#auth.ts';
import { readLimited } from '#body.ts';
import { serializeResult } from '#plugins.ts';
import * as LOG from './log-events.ts';

const MAX_CONFIG_BODY = 64 * 1024;

const text = (body: string, status: number): Response => new Response(body, { status });

const toIssues = (error: PluginConfigError) =>
  // `invalid` é o caso comum e fica sem `kind`: só os que mudam a UI (ex.: `undecryptable`) o levam.
  error.issues.map(({ path, message, kind }) => ({
    path,
    message,
    kind: kind === 'invalid' ? undefined : kind,
  }));

/**
 * Rotas `/api/config/:plugin` (M5-4.2): view com secrets mascarados + JSON Schema para o
 * formulário, e gravação de overrides. O `PUT` recusa secret; ele se grava pelas rotas `/secrets/:path` (ADR 0117).
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
      try {
        if (!admin.plugins().some((entry) => entry.name === name)) {
          return Promise.resolve(text('plugin desconhecido', 404));
        }
      } catch (error) {
        return Promise.resolve(fail('checar', name, error));
      }
      return handler(admin, name, request, info);
    };

  const fail = (what: string, name: string, error: unknown, body = 'erro interno'): Response => {
    // O erro inteiro (stack incluso): o logger do core já censura os secrets.
    ctx.log.event(LOG.configFailed, { action: what, target: name, err: error });
    return text(body, 500);
  };

  // Falhas de escrita (override ou segredo) com a mesma tradução para HTTP. `kind` vem do core.
  const writeFailure = (name: string, error: unknown): Response => {
    if (error instanceof PluginConfigError) {
      const kinds = error.issues.map((issue) => issue.kind);
      const kind = kinds.includes('secret')
        ? 'secret'
        : kinds.includes('shadowed')
          ? 'shadowed'
          : 'invalid';
      // `shadowed`: o env ou o arquivo definem o campo, é conflito de estado e não valor ruim.
      return Response.json(
        { error: kind, issues: toIssues(error) },
        { status: kind === 'shadowed' ? 409 : 400 },
      );
    }
    // O valor é gravado antes do reload: falha do reload deixa o salvo.
    if (error instanceof PluginHostStateError) {
      return text(
        `${error.message.slice(0, 300)} (se a config era válida, ficou salva, mas o reload falhou)`,
        409,
      );
    }
    // Rejeitado antes de gravar: nada ficou salvo, é só tentar de novo.
    if (error instanceof ContextExpiredError) {
      return text('dashboard sendo recarregado, tente de novo', 503);
    }
    return fail('gravar', name, error, 'erro interno (a mudança pode ter sido salva sem o reload)');
  };

  ctx.http.route(
    'GET',
    '/api/config/:plugin',
    guarded(
      withAdmin(async (admin, name) => {
        try {
          const schema = admin.config.jsonSchema(name) ?? null;
          const secretsWritable = admin.config.secretsWritable;
          try {
            return Response.json({
              view: await admin.config.describe(name),
              schema,
              secretsWritable,
            });
          } catch (error) {
            // Config atual inválida: é quando o admin mais precisa do formulário para corrigir.
            if (error instanceof PluginConfigError) {
              return Response.json({
                view: null,
                schema,
                issues: toIssues(error),
                secretsWritable,
              });
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
          return writeFailure(name, error);
        }
      }),
    ),
  );

  // Segredo cifrado (ADR 0117). O valor só trafega no corpo do PUT e nunca volta na resposta.
  const secretRoute = (
    apply: (
      admin: PluginAdmin,
      name: string,
      path: string,
      request: Request,
    ) => Promise<Response | PluginChangeResult | undefined>,
  ) =>
    guarded(
      withAdmin(async (admin, name, request, info) => {
        if (!sameOrigin(request)) return text('origem inválida', 403);
        if (name === ctx.plugin.name) {
          return text(
            'o dashboard não altera a própria config pelo painel; use o arquivo ou o env',
            409,
          );
        }
        try {
          const result = await apply(admin, name, info.params['path'] ?? '', request);
          if (result instanceof Response) return result;
          return Response.json(result === undefined ? null : serializeResult(result));
        } catch (error) {
          return writeFailure(name, error);
        }
      }),
    );

  ctx.http.route(
    'PUT',
    '/api/config/:plugin/secrets/:path',
    secretRoute(async (admin, name, path, request) => {
      const body = await readLimited(request, MAX_CONFIG_BODY);
      if (body === undefined) return text('corpo grande demais', 413);
      let value: unknown;
      try {
        value = (JSON.parse(body) as { value?: unknown } | null)?.value;
      } catch {
        return text('JSON inválido', 400);
      }
      if (value === undefined) return text('o corpo deve ser { "value": ... }', 400);
      return admin.config.setSecret(name, path, value as JsonValue);
    }),
  );

  ctx.http.route(
    'DELETE',
    '/api/config/:plugin/secrets/:path',
    secretRoute((admin, name, path) => admin.config.clearSecret(name, path)),
  );
}
