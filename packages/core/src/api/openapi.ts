// Documento OpenAPI 3.2 a partir das operações registradas (ADR 0125). Função pura: não abre
// servidor nem transport, então serve o `GET /openapi.json` e a exportação da CLI.

import type { createDocument } from 'zod-openapi';
import { CORE_VERSION } from '#version.ts';
import { apiLibs, loadApiLibs } from './libs.ts';
import type { ApiRoute } from './operation.ts';
import { PROBLEM_CONTENT_TYPE, problemSchema } from './problem.ts';

/** `/users/:id` do router vira `/users/{id}` da OpenAPI. */
function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

export async function createOpenApiDocument(
  routes: Iterable<ApiRoute>,
  options: { readonly version?: string } = {},
): Promise<ReturnType<typeof createDocument>> {
  await loadApiLibs();
  // biome-ignore lint/suspicious/noExplicitAny: caminhos montados dinamicamente
  const paths: Record<string, Record<string, any>> = {};
  for (const { path, operation } of routes) {
    const requestParams = {
      ...(operation.params && { path: operation.params }),
      ...(operation.query && { query: operation.query }),
    };
    const item = paths[openApiPath(path)] ?? {};
    paths[openApiPath(path)] = item;
    item[operation.method.toLowerCase()] = {
      ...(operation.summary && { summary: operation.summary }),
      ...(operation.tags && { tags: [...operation.tags] }),
      ...(Object.keys(requestParams).length > 0 && { requestParams }),
      ...(operation.body && {
        requestBody: {
          required: true,
          content: { 'application/json': { schema: operation.body } },
        },
      }),
      responses: {
        [String(operation.status ?? 200)]: {
          description: 'Sucesso',
          content: { 'application/json': { schema: operation.response } },
        },
        default: {
          description: 'Erro (RFC 9457)',
          content: { [PROBLEM_CONTENT_TYPE]: { schema: problemSchema() } },
        },
      },
    };
  }
  return apiLibs().createDocument({
    openapi: '3.2.0',
    info: { title: 'Bridger API', version: options.version ?? CORE_VERSION },
    paths,
  } as Parameters<typeof createDocument>[0]);
}
