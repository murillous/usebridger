# Pesquisa M7: OpenAPI a partir do Zod, SSE na spec e Refine

Pesquisa da issue #273 (M7-1), insumo do ADR 0125 (M7-2). Tudo abaixo foi rodado num protótipo
descartável, na branch `proto/m7-api` (pasta `prototypes/m7-api/`), que não entra na `develop`.
Versões e datas consultadas no npm em 2026-10-25, Node 24.21.

## Resumo das recomendações

| Item | Recomendação | Descartado |
| --- | --- | --- |
| Spec a partir do Zod | `zod-openapi` sobre uma tabela de rotas que o core já mantém | `@hono/zod-openapi`; montar à mão fica de plano B |
| Tempo real na spec | SSE com `itemSchema` (OpenAPI 3.2) e o item como componente nomeado | pacote separado só com os tipos dos eventos |
| Cliente | `openapi-typescript` + `openapi-fetch`, codegen isolado com TypeScript 5 | — |
| Dashboard | Refine (headless, `@refinedev/core`) com data provider sobre `openapi-fetch` | UI kit próprio do Refine |
| Formulário de config | `@rjsf/core` + `@rjsf/shadcn` direto do JSON Schema | AutoForm |

## Spec a partir do Zod

Cenário igual nas três opções: componentes com `$ref` (`Plugin`, `LogEvent`, `Problem`), rota com
query, rota com path param, `PATCH` com body, rota SSE e uma rota registrada **depois** da
primeira requisição, como um plugin carregado tarde.

Primeiro achado, que vale para qualquer opção: o router do Hono recusa rota nova depois do
primeiro match (`Error: Can not add a route since the matcher is already built.`). O core já
contorna isso remontando o app a partir de uma tabela a cada mudança
(`packages/core/src/http/server.ts`). A spec tem de sair da **mesma tabela**, gerada na hora do
`GET /openapi.json`; com isso a rota tardia aparece na spec e responde.

| Critério | A: à mão sobre `z.toJSONSchema` | B: `@hono/zod-openapi` 1.6.3 | C: `zod-openapi` 6.0.2 |
| --- | --- | --- | --- |
| `$ref` em `components` | sim, com contorno (abaixo) | sim, via `.meta({ id })` | sim, via `.meta({ id })` |
| Rotas de plugin em runtime | lê a tabela do core | spec presa ao `OpenAPIHono`: cada remontagem refaz `app.openapi()` de todas as rotas | lê a tabela do core; `createDocument` é função pura |
| OpenAPI 3.2 / `itemSchema` | sim (o documento é nosso) | só `getOpenAPI31Document`; `itemSchema` sai, mas pede cast porque não existe no tipo | `openapi: '3.2.0'` e `itemSchema` tipados |
| Dependência | nenhuma | 120 kB + `@asteasolutions/zod-to-openapi` (229 kB) + `openapi3-ts` + `@hono/zod-validator` | 195 kB, só `zod` como peer |
| Licença / último publish | — | MIT / 2026-09-04 | MIT / 2026-08-31 |

Contorno da opção A: `z.toJSONSchema(schema, { metadata })` de um schema solto emite `$defs`
locais, não `$ref` para `#/components/schemas`. Só a conversão de um **registro inteiro** com
`uri` emite `$ref` externo. O protótipo põe cada schema de rota num registro temporário com id
sintético, converte o registro e troca os marcadores. Funciona, mas são ~30 linhas que o core
passaria a manter, além do mapeamento de `parameters`, `requestBody` e `required` da query.

**Recomendação: C.** Gera o documento de um objeto simples, que é o formato da tabela que o core
já tem; tipa 3.2 e `itemSchema`; não acopla a API de plugin ao `createRoute` do Hono. B fica fora
porque amarra a spec à instância do `OpenAPIHono` e não emite 3.2. A é o plano B se a dependência
virar problema.

Ponto aberto para o ADR: o core lê o schema de config pelo Zod que o plugin carregou
(`packages/core/src/config/schema.ts`). Não foi testado aqui um schema criado por uma cópia do
Zod diferente da que o `zod-openapi` importa.

## Tempo real na spec (SSE)

A OpenAPI 3.2 descreve SSE como `text/event-stream` com `itemSchema`; o `data` em JSON vai como
`contentMediaType: application/json` + `contentSchema`. O protótipo serve a spec 3.2 e o stream
com `streamSSE` do Hono, e as três opções emitem o `itemSchema` com `$ref` para o componente.

`openapi-typescript` 7.13.0 **ignora** `itemSchema`: a resposta sai como
`"text/event-stream": unknown`. Suporte a 3.2 está pedido e aberto
([openapi-ts/openapi-typescript#2577](https://github.com/openapi-ts/openapi-typescript/issues/2577)).
O componente nomeado, porém, sai tipado. Então o plano B fica mais leve que um pacote de tipos:
todo item de stream é componente com id e o cliente usa `components['schemas']['LogEvent']`.
Quando o `openapi-typescript` suportar 3.2, o tipo passa a vir da própria rota sem mudar a spec.

Achados do browser, para M7-4 e M7-5:

- `EventSource` reconecta sozinho quando o stream fecha; no protótipo os eventos se repetiram.
  O servidor precisa mandar `id` e retomar pelo `Last-Event-ID`, ou o stream nunca fecha.
- `EventSource` não manda header customizado. API key em `Authorization` não serve para o
  dashboard no browser: lá a autenticação do stream é por cookie de sessão (ou leitura do stream
  com `fetch`, que perde a reconexão automática).

## Cliente

`openapi-typescript` gerou os tipos da spec do bot rodando (`/openapi.json`) e do arquivo
exportado sem servidor; as duas saídas são idênticas. Com `openapi-fetch` o cliente fez `GET`
com query, `GET` com path param (404 em `application/problem+json` chega em `error`), `PATCH` com
body, e o `tsc` barrou rota inexistente e valor fora do enum (`@ts-expect-error` nos dois).

| Pacote | Versão | Licença | Último publish |
| --- | --- | --- | --- |
| `openapi-typescript` | 7.13.0 | MIT | 2026-06-15 |
| `openapi-fetch` | 0.17.0 | MIT | 2026-06-15 |

Achado: `openapi-typescript` usa a API de compilador do TypeScript 5 (peer `typescript ^5.x`) e
**quebra com o TypeScript 7 do repo** (`Cannot read properties of undefined (reading
'createKeywordTypeNode')`). Nem `overrides` nem `packageExtensions` do pnpm trocam a resolução do
peer. O que funcionou: rodar o codegen isolado,
`pnpm dlx --package typescript@5 --package openapi-typescript@7.13.0 openapi-typescript <spec> -o <saida>`.
O `openapi-fetch` não tem esse problema: o cliente passa no `tsc` 7.0.2.

`openapi-fetch` é pré-1.0; minor pode quebrar, então a versão fica fixa.

## Dashboard

O `plugin-dashboard` já é React 19 + Vite 8, a mesma base do protótipo. Um app Vite com
`@refinedev/core` 5.0.12 e um data provider sobre o `openapi-fetch` (`getList`, `getOne`,
`update`), renderizado no Chrome headless, mostrou:

- recurso `plugins` listado com `useList`, com o filtro virando query da API;
- `useUpdate` mandando `PATCH`;
- eventos SSE chegando pelo `EventSource` no browser;
- formulário gerado pelo `@rjsf/core` a partir do componente `Plugin` lido do `/openapi.json`.

Bundle de produção sem code split (React, Refine, React Query, rjsf, ajv): 776 kB, 248 kB gzip.

O data provider é genérico porque os recursos de plugin só existem em runtime: ele fala com
caminhos dinâmicos e perde a tipagem por recurso. As telas fixas do core usam o cliente tipado
direto. O shadcn/ui não entrou no protótipo: é código copiado pela CLI, sem contrato com o Refine
headless, então não muda nada do que foi verificado.

Formulário de config:

- **rjsf** lê JSON Schema direto, que é o que a API publica. `@rjsf/core` 6.11.0 (Apache-2.0) e
  `@rjsf/shadcn` 6.11.0 (MIT), publicados em 2026-09-29.
- **AutoForm** recebe schema Zod. O browser teria de passar o JSON Schema por `z.fromJSONSchema`,
  que funciona num schema sem referências, mas falha com `$ref` externo
  (`Reference not found: #/components/schemas/Plugin`). O `@autoform/shadcn` do npm está parado
  em 1.0.1 desde 2024-10; a variante shadcn é distribuída como código copiado.

| Pacote | Versão | Licença | Último publish |
| --- | --- | --- | --- |
| `@refinedev/core` | 5.0.12 | MIT | 2026-04-20 |
| `@rjsf/core` / `@rjsf/shadcn` | 6.11.0 | Apache-2.0 / MIT | 2026-09-29 |
| `@autoform/react` / `@autoform/zod` | 5.0.0 / 6.0.0 | MIT | 2026-07-08 |

O `@refinedev/core` está há seis meses sem publish; vale reavaliar antes do M7-10.

## O que ficou de fora

- Interação no browser além da renderização: o filtro e o submit do formulário não foram
  clicados no headless; o filtro foi verificado pela API.
- shadcn/ui, rotas do Refine (`@refinedev/react-router`) e autenticação (`authProvider`).
- Schema de config criado por outra cópia do Zod (ponto aberto acima).
- Ferramenta de documentação navegável da spec (Scalar, Swagger UI).
