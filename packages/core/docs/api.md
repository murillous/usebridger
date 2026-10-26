# API HTTP

O core expõe uma API HTTP descrita em OpenAPI 3.2 sobre o [servidor HTTP](http.md)
([ADR 0125](../../../docs/adr/0125-api-http-do-core-e-dashboard-cliente.md),
[ADR 0126](../../../docs/adr/0126-rotas-da-api-de-plugin-sob-api-plugins.md)). Sem auth ainda
(M7-4): não exponha a porta fora de uma rede confiável.

| Sessão | Base da API | Spec |
| --- | --- | --- |
| `default` | `/api` | `GET /openapi.json` |
| outra (`erp`) | `/sessions/erp/api` | `GET /openapi.json` (uma spec para o processo todo) |

`GET /api/health` é a operação de exemplo (mesmos dados do `/health`, que continua no ar).

## Registrar uma operação

```ts
import { ApiError, definePlugin } from '@usebridger/core';
import { z } from 'zod';

export default definePlugin({
  name: 'tarefas',
  version: '1.0.0',
  engine: '>=0.9.0',
  setup(ctx) {
    ctx.http.api({
      method: 'GET',
      path: '/items/:id', // vira GET /api/plugins/tarefas/items/:id
      summary: 'Busca um item',
      params: z.object({ id: z.string().regex(/^\d+$/) }),
      query: z.object({ verbose: z.enum(['0', '1']).default('0') }),
      response: z.object({ id: z.string() }).meta({ id: 'Item' }), // `id` vira componente
      handler: ({ params, query }) => {
        if (params.id === '0') throw new ApiError(404, 'item não existe');
        return { id: params.id };
      },
    });
  },
});
```

- O caminho é relativo ao dono: `/api/plugins/<nome>` no plugin, `/api/transports/<nome>` no
  transport. Mesmo método e caminho duas vezes lança `HttpRouteConflictError`.
- `params`, `query` e `body` são opcionais; presentes, o core valida antes do handler. `body` é
  JSON. `status: 201` troca o status de sucesso.
- `response` só alimenta a spec: o core não confere o retorno do handler.
- Query string repetida chega como array; use `z.coerce` para números.
- A porta só abre se algum plugin ou transport registrar rota; sozinha, a API do core não abre.

## Erros (problem+json)

Todo erro sob a API sai como `application/problem+json` (RFC 9457) e o componente `Problem` da
spec:

```json
{ "type": "about:blank", "title": "Bad Request", "status": 400, "detail": "entrada inválida",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "errors": [{ "in": "path", "path": "id", "message": "Invalid string", "code": "invalid_format" }] }
```

| Situação | Status |
| --- | --- |
| Params, query ou body inválidos (inclui JSON ilegível) | 400 com `errors` |
| `throw new ApiError(401 \| 403 \| 404 \| 409, detalhe)` | o status pedido |
| Caminho desconhecido sob `/api` | 404 |
| Qualquer outro erro do handler | 500 sem `detail` nem stack; o erro vai para o log (`plugin.error` com `phase: 'http'` no plugin, `http.unhandled` no core) |

O `traceId` é o do [ADR 0120](../../../docs/adr/0120-trace-e-trilha-de-eventos.md): o mesmo que
aparece nas linhas de log da requisição.

## Ler a spec

`GET /openapi.json` monta o documento a cada pedido, a partir da tabela atual de rotas (core e
plugins, inclusive os que carregaram depois do boot). Sem servidor, para o CLI ou um build:

```ts
import { coreApiRoutes, createOpenApiDocument } from '@usebridger/core';

const spec = await createOpenApiDocument(await coreApiRoutes()); // só o core; aceita { version }
```

`createOpenApiDocument` recebe qualquer lista de `{ path, operation }` (`ApiRoute`).

## CORS

Desligado por padrão: sem config, a API não manda header CORS e o preflight `OPTIONS` não é
respondido. Para um painel em outra origem:

```ts
createBot({ http, api: { cors: { origins: ['https://painel.exemplo.com'] } }, ... });
```

Origem exata (esquema, host e porta), sem curinga. Só origem da lista recebe
`Access-Control-Allow-Origin` (com `Allow-Credentials: true` e `Vary: Origin`); o preflight
dessas origens responde 204. Vale só para `/api`.

## Snapshot da spec do core

A spec do core fica versionada em `packages/core/src/api/__snapshots__/openapi.json`, e o teste
`src/api/api.test.ts` falha (no CI também, via `pnpm test`) se ela mudar sem o arquivo mudar.

Mudança proposital: rode `pnpm exec vitest run packages/core/src/api -u`, confira o diff do
arquivo no PR e crie o changeset. A spec é contrato semver: remover ou mudar rota, campo ou enum
exige changeset **`major`** do `@usebridger/core`; acrescentar é `minor`.
