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

- O caminho é relativo ao dono: `/api/plugins/<nome>` no plugin. Mesmo método e caminho duas vezes lança `HttpRouteConflictError`.
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

## Gerar a spec e o cliente

O comando `bridger openapi [módulo] [--out <arquivo>]` escreve a spec OpenAPI 3.2 (JSON) no
stdout, ou em `--out`, sem conectar transport nem abrir porta:

```sh
bridger openapi --out openapi.json              # só o core
bridger openapi ./src/plugins.ts --out openapi.json  # core + plugins do app
```

O módulo é um arquivo do app que exporta, por named export, a lista de plugins:
`export const plugins = [meuPlugin, outroPlugin]` (a mesma lista que vai na config do bot). O
comando o importa, e isso é seguro porque importar o módulo do app não tem efeito colateral
([ADR 0003](../../../docs/adr/0003-uma-sessao-por-processo.md)).

Para coletar as operações, o comando roda o `setup` de cada plugin (prazo de 10 s, e depois o
`teardown`, com `ctx.signal` abortado) com um contexto em que só `ctx.http`, `ctx.plugin`,
`ctx.signal` e `ctx.config` são reais. `ctx.config` traz os defaults do schema do plugin; se o
schema tem campo obrigatório, `config` e o resto de `ctx` (storage, scheduler, commands) viram um
no-op. O kernel não toca em nada externo, mas o código do próprio plugin roda: registre a API no
começo do `setup` e deixe conexões e timers para depois. Operações registradas sob condição da
config real podem não bater com as do runtime. Uso inválido ou `setup` que falha saem com código 1
e mensagem no stderr.

Módulo `.ts` depende do type-stripping do Node: sem `enum`, com imports usando a extensão `.ts` e
sem os aliases do tsconfig. Se o app usa algo disso, passe o `.js` do build.

Tipos e cliente no frontend (o `openapi-typescript` roda isolado em TypeScript 5,
[ADR 0125](../../../docs/adr/0125-api-http-do-core-e-dashboard-cliente.md); não é dependência do core):

```sh
pnpm dlx --package typescript@5 --package openapi-typescript@7.13.0 openapi-typescript openapi.json -o src/api-types.d.ts
```

```ts
import createClient from 'openapi-fetch'; // fixe a versão exata no package.json do frontend
import type { paths } from './api-types';

const api = createClient<paths>({ baseUrl: 'http://localhost:3000' });
const { data, error } = await api.GET('/api/health'); // `error` é o problem+json tipado
```

## CORS

Desligado por padrão: sem config, a API não manda header CORS e o preflight `OPTIONS` não é
respondido. Para um painel em outra origem:

```ts
createBot({ http, api: { cors: { origins: ['https://painel.exemplo.com'] } }, ... });
```

Origem exata (esquema, host e porta), sem curinga. Só origem da lista recebe
`Access-Control-Allow-Origin` (com `Allow-Credentials: true` e `Vary: Origin`); o preflight
dessas origens responde 204. Com o CORS ligado, toda resposta leva `Vary: Origin`. Vale para `/api` e para `/openapi.json` (união das origens das sessões).

## Snapshot da spec do core

A spec do core fica versionada em `packages/core/src/api/__snapshots__/openapi.json`, e o teste
`src/api/api.test.ts` falha (no CI também, via `pnpm test`) se ela mudar sem o arquivo mudar.

Mudança proposital: rode `pnpm exec vitest run packages/core/src/api -u`, confira o diff do
arquivo no PR e crie o changeset. A spec é contrato semver: remover ou mudar rota, campo ou enum
exige changeset **`major`** do `@usebridger/core`; acrescentar é `minor`.
