# ADR 0134 — Recursos de plugin pela API (`api.resources`)

**Status:** Aceito (2026-10-27) · Complementa o [ADR 0125](0125-api-http-do-core-e-dashboard-cliente.md),
o [ADR 0126](0126-rotas-da-api-de-plugin-sob-api-plugins.md) e o
[ADR 0127](0127-base-da-autenticacao-da-api.md)

## Contexto

O ADR 0125 troca o `dashboard.tabs` por um ponto `api.resources`: o plugin declara dados, schema,
operações, ações e permissões, e qualquer frontend desenha a tela. Falta fixar o formato, os
caminhos, como o recurso entra e sai da API e como as permissões do plugin chegam à auth, que até
aqui só conhecia as do core (ADR 0127 deixou isso para o M7-8).

## Decisão

- **Ponto `api.resources`** declarado no core (`ExtensionPoints`), com a contribuição
  `ApiResource`: `id`, `schema` Zod do item, `permissions: { read, write }`, `filter` opcional e as
  operações opcionais `list`, `get`, `create`, `update`, `delete` e `actions`. `defineResource` só
  tipa. Não há campo de UI.
- **Caminhos** em `/api/resources/<plugin>/<id>`: `GET` (list, com `cursor`, `limit` 1–100 e os
  campos do `filter` na query) e `POST` (create, 201) na coleção; `GET`, `PATCH` e `DELETE` em
  `/{id}`; ações em `POST /{id}/actions/<ação>`. Fica fora de `/api/plugins/<nome>` para não
  colidir com as operações livres do plugin nem com as do core ali (ADR 0131).
- **Operação ausente não vira rota**: o caminho dá 404 problem+json e não entra na spec.
- **Cada operação é uma `ApiOperation`** montada pelo core: valida entrada (400), aplica a
  permissão (401/403 auditado), sai na spec com `x-permission` e `x-resource`
  (`{ plugin, resource, operation, action?, confirm? }`), que diz ao frontend o que cada rota é.
  `list`/`get` pedem `read`; o resto pede `write`, ou a `permission` da ação. `get`/`update`
  devolvendo `undefined` e `delete` devolvendo `false` viram 404.
- **Validação no `contribute`**: contribuição inválida (id, schema, permissão fora de
  `<área>.<ação>`, nenhuma operação, ação repetida) lança `BotConfigError` e falha o `setup`, em vez
  de virar 500 ou spec quebrada depois.
- **Ciclo de vida pelo dono**: a `SessionHttp` guarda os recursos com o plugin que contribuiu e os
  expande em operações a cada montagem do app (o Zod do core só carrega com a porta). O
  `removeOwner` do teardown, reload e disable tira o recurso da API e da spec junto com as rotas.
  Sem `BotConfig.http`, o recurso só fica no ponto.
- **Ator no handler**: `{ id, kind, name, onBehalfOf?, can(permissão) }`, ou `undefined` com a auth
  desligada (loopback, ADR 0128).
- **Catálogo de permissões dinâmico**: as permissões declaradas pelos plugins carregados (recursos
  e `ctx.http.api`) entram nos papéis pela regra de sempre (`owner`/`admin` todas, `viewer` as
  `.read`) e são aceitas no escopo de API key. Lidas a cada request: plugin desligado leva as dele.

## Consequências

- Operação de `ctx.http.api` com `permission` própria do plugin deixa de dar 403 até para o owner.
- Uma permissão de plugin descarregado some dos papéis; a chave que a tem no escopo guarda o texto,
  e ela volta a valer quando o plugin volta.
- O `plugin-dashboard` ainda lê o `dashboard.tabs`; a troca do cliente é do M7-10 (#280).
- Dois plugins podem declarar o mesmo nome de permissão e passam a dividi-la. Prefixe pela área do
  plugin.
