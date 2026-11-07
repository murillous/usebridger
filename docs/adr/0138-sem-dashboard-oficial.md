# ADR 0138 — Sem dashboard oficial: cada app monta o seu sobre a API do core

**Status:** Aceito (2026-11-07) · Substitui o **D19**
([ADR 0019](0019-dashboard-vira-plugin.md)) · Substitui em parte o **D103**
([ADR 0103](0103-plugins-oficiais-de-metricas-e-dashboard.md)) (o `plugin-dashboard`) e o **D125**
([ADR 0125](0125-api-http-do-core-e-dashboard-cliente.md)) (o dashboard como cliente) · Usa
**D125** e **D117** ([ADR 0117](0117-segredos-cifrados-editaveis-pelo-dashboard.md))

## Contexto

O D125 levou tudo o que o dashboard mostrava para a API HTTP do core, descrita em OpenAPI. O
`plugin-dashboard` virou só o servidor de um app web genérico: sem rota de dados, sem auth e sem
config próprias. O que ele faz, qualquer app faz pela mesma API.

Manter o app no monorepo tem custo:

- Toda mudança na API regera `api-types.d.ts` no dashboard e mexe em telas, testes e changeset
  de um pacote que não muda o que o core oferece.
- O app traz React, Vite, `@rjsf`, happy-dom e o próprio build, o maior conjunto de dependências do
  repo para um pacote que nenhum consumidor real usa como está. O LumaBot e os painéis de app
  querem telas próprias, com a cara e o fluxo do produto.
- Um painel genérico oficial vira referência do que "o Bridger mostra" e puxa pedidos de UI para
  o kernel, que só deveria responder pela API (ADR 0011).

A configuração dispensa o painel: a precedência env > arquivo > overrides > default (ADR 0015,
ADR 0028) cobre o operador, e `GET`/`PUT /api/plugins/{name}/config` cobre quem quiser editar em
tempo real, segredos inclusive (ADR 0117).

Alternativas consideradas:

- **Manter o `plugin-dashboard` como está.** Custo contínuo de manutenção para um app que os
  consumidores reais trocam pelo próprio.
- **Mover o dashboard para um repositório à parte**, como exemplo. Continua sendo código a manter
  contra cada versão da API, sem dono e sem usuário.
- **Reduzir a um exemplo em `examples/`.** O exemplo mínimo útil ainda carrega login, SSE e
  formulário de config, e sai do ar a cada mudança de contrato do mesmo jeito.

## Decisão

- **O Bridger não publica dashboard.** O pacote `@usebridger/plugin-dashboard` sai do monorepo e
  é marcado como `deprecated` no npm. As versões publicadas continuam instaláveis.
- **O contrato para painéis é a API HTTP do core** e a spec em `GET /openapi.json` (ou
  `bridger openapi`, sem servidor). Cada app que precisar de painel monta o seu sobre ela, com a
  auth e as permissões dela, e gera os tipos da spec se quiser.
- **Configuração** por env ou arquivo para quem opera, e pela rota de config da API para quem quiser
  tela. O core não muda.
- **O `plugin-metrics` segue como o único plugin oficial.** A parte do D103 sobre métricas vale
  como está.
- **Fica do D125:** a API, a spec, a auth no core, o SSE e o `api.resources`. Sai só o
  `plugin-dashboard` como cliente, com o Refine, o `@rjsf` e o codegen que ele usava.

## Consequências

- Mudança na API deixa de arrastar um app junto: o contrato fica vigiado só pelo snapshot da spec.
- Quem usa o `plugin-dashboard` fica na última versão publicada, que pode não acompanhar majors
  futuros do core, ou migra para um painel próprio.
- Sem um consumidor de UI no repo, nada exercita a API de ponta a ponta pelo browser. Os testes da
  API no core passam a ser a única garantia.
- Painel de administração pronto deixa de ser argumento do Bridger: um app novo começa sem tela e
  precisa construir a sua.
