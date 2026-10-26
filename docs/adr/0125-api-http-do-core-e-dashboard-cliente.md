# ADR 0125 — API HTTP do core em OpenAPI e dashboard como cliente

**Status:** Aceito (2026-10-25) · Substitui o **D104**
([ADR 0104](0104-abas-do-dashboard-por-ponto-de-extensao.md)), o **D109**
([ADR 0109](0109-contrato-das-abas-do-dashboard-complemento.md)) e o **D114**
([ADR 0114](0114-titulo-tom-e-rotulo-nos-widgets-das-abas.md)) · Substitui em parte o **D19**
([ADR 0019](0019-dashboard-vira-plugin.md)) (rotas e autenticação do dashboard) e o **D72**
([ADR 0072](0072-http-do-core.md)) (sem autenticação no kernel) · Usa **D117**
([ADR 0117](0117-segredos-cifrados-editaveis-pelo-dashboard.md)), **D121**
([ADR 0121](0121-plugin-metrics-sobre-o-prom-client.md)) e **D122**
([ADR 0122](0122-log-de-auditoria-no-kernel.md))

## Contexto

O `plugin-dashboard` é dono das próprias rotas (status, QR, logs por WebSocket, plugins, config,
abas) e de uma autenticação por token único. Os plugins contribuem telas por widgets declarativos
no ponto `dashboard.tabs` (ADR 0104, 0109, 0114). Isso tem dois custos:

- **A UI fica engessada.** Toda tela nova de plugin cabe no vocabulário de widgets, ou exige
  mudar o contrato das abas.
- **Os dados ficam presos ao dashboard.** Um app que consome o Bridger (o LumaBot, um painel de
  licitação) não chega ao status, aos logs ou à config sem passar pelo dashboard oficial, ou sem
  reimplementar as rotas dele.

A pesquisa da M7-1 (#273, [`docs/research/m7-api-dashboard.md`](../research/m7-api-dashboard.md))
rodou um protótipo e trouxe:

- O router do Hono recusa rota nova depois do primeiro match. O core já remonta o app a partir de
  uma tabela (ADR 0072); a spec tem de sair da mesma tabela, gerada a cada `GET /openapi.json`.
- `zod-openapi` gera o documento de um objeto simples, tipa OpenAPI 3.2 e o `itemSchema` de SSE,
  e não acopla a API de plugin ao `createRoute` do Hono. `@hono/zod-openapi` prende a spec à
  instância do app e não emite 3.2. Montar à mão sobre `z.toJSONSchema` funciona, com ~30 linhas
  de contorno para `$ref`.
- `openapi-typescript` 7.13 ignora o `itemSchema` (o stream sai `unknown`), mas tipa os
  componentes nomeados. Ele quebra com o TypeScript 7 do repo; o codegen roda isolado com
  TypeScript 5.
- `EventSource` reconecta sozinho e não manda header customizado: o stream precisa de `id` e
  `Last-Event-ID`, e o browser autentica por cookie.
- Refine headless (`@refinedev/core`) com data provider sobre `openapi-fetch` cobriu lista,
  `PATCH`, SSE e formulário `@rjsf` no browser. O Refine perdeu ritmo: o repo está em `5.2.0` e o
  npm parou no `5.0.12`, de abril.

Alternativas consideradas:

- **Manter o dashboard dono das rotas** e só documentá-las. Os dados continuam presos a um plugin,
  e a auth continua sendo do plugin.
- **WebSocket para tempo real**, como hoje. Bidirecional sem necessidade, fora do HTTP puro, sem
  reconexão nem retomada prontas e sem lugar na OpenAPI.
- **Continuar com widgets declarativos** e ampliar o vocabulário. Cada tela nova ainda passa pelo
  contrato das abas.
- **Atendimento humano no kernel** (inbox, filas de atendente). É produto, não kernel; cada app
  tem a sua ferramenta.

## Decisão

- **Tudo o que o dashboard mostra sai da API HTTP pública do core.** A API roda sobre o servidor do
  ADR 0072, sob `/api` na sessão `default` e `/sessions/<sessão>/api` nas outras, como as rotas de
  plugin.
- **Descrita em OpenAPI 3.2**, servida em `GET /openapi.json` e gerada na hora a partir da tabela
  de rotas, porque depende dos plugins carregados. A CLI exporta o mesmo documento sem servidor. A
  geração usa o `zod-openapi`, com a montagem à mão como plano B. Erro sai em
  `application/problem+json`.
- **Áreas:** conexão (status, QR, código de pareamento, logout), tempo real, logs, plugins,
  configuração com segredos (ADR 0117), métricas (`query` e `catalog()` do ADR 0121), auditoria
  (ADR 0122), auth e recursos de plugin.
- **Recursos de plugin pelo ponto `api.resources`**, no lugar do `dashboard.tabs`. O plugin declara
  os dados, o schema Zod, as operações, as ações e as permissões. Não declara UI: o dashboard
  monta a tela a partir do schema, e outro app monta a sua.
- **Autenticação no core**, que deixa de ser do handler (D72) para a API: usuários com sessão em
  cookie para pessoas, API keys para máquinas, permissões `<área>.<ação>`, papéis fixos `owner`,
  `admin` e `viewer`, e o header `X-Bridger-On-Behalf-Of` para um backend intermediário (BFF)
  agir em nome de um usuário. O detalhe fica na M7-4 (#223). As rotas de `ctx.http` fora da API
  continuam conferindo o próprio acesso.
- **Tempo real por SSE**, não WebSocket: o fluxo é só do servidor, é HTTP puro e usa a mesma auth.
  Todo evento leva `id` e o servidor retoma pelo `Last-Event-ID`. Cada item de stream é componente
  nomeado na spec, para o cliente ter o tipo mesmo sem suporte do `openapi-typescript` ao
  `itemSchema`.
- **Cliente tipado:** `openapi-typescript` + `openapi-fetch`, em versão fixa (o `openapi-fetch` é
  pré-1.0), com o codegen rodando isolado em TypeScript 5.
- **`plugin-dashboard` vira cliente genérico da API**, sem rota nem auth próprias. Usa Refine
  headless (só o `@refinedev/core`) com data provider sobre o `openapi-fetch`, em versão fixa e sem
  tipo do Refine fora do data provider e dos hooks. Antes do M7-10 (#280), se a 5.2 não tiver
  chegado ao npm, troca por React Query direto. Formulários saem do JSON Schema pelo `@rjsf`.
- **Atendimento humano fica fora do kernel.** Cada app integra o que quiser (ex.: Chatwoot) por
  plugin próprio sobre a API pública.
- **Sem compatibilidade com o dashboard atual.** A API vira contrato semver, vigiado por snapshot
  da spec no CI.

## Consequências

- `breaking` no `plugin-dashboard`: as rotas, o token único, o WebSocket de logs e o
  `dashboard.tabs` somem. Plugins que contribuíam abas migram para `api.resources`.
- O core ganha `zod-openapi` como dependência e passa a ter auth, usuários e API keys no storage.
- A spec é contrato: rota, campo ou enum removido é major do core. O snapshot no CI torna a
  mudança visível no PR.
- Qualquer app chega aos mesmos dados que o dashboard, com o mesmo controle de acesso.
- O data provider é genérico, porque os recursos de plugin só existem em runtime, e perde a
  tipagem por recurso. As telas fixas do core usam o cliente tipado direto.
- Fica em aberto o schema de config criado por uma cópia do Zod diferente da que o `zod-openapi`
  importa; a M7-6 (#277) confere.
