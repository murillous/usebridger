# ADR 0103 — Plugins oficiais de métricas e dashboard

**Status:** Aceito (2026-10-17) · Agregação, histograma, `/metrics` e retenção: substituídos em
parte pelo **D121** ([ADR 0121](0121-plugin-metrics-sobre-o-prom-client.md)) · Substitui parte do **D82**
([ADR 0082](0082-plugins-da-luma-no-lumabot.md)) · Detalha **D19**
([ADR 0019](0019-dashboard-vira-plugin.md)) · Usa **D102** ([ADR 0102](0102-observadores-do-core.md))
e **D101** ([ADR 0101](0101-incremento-atomico-na-colecao.md))

## Contexto

O D82 tirou os plugins do kernel: o dashboard virou código do LumaBot. Mas quase todo app sobre o
Bridger quer as mesmas coisas: um painel com QR, status, logs e config, e as métricas do bot
(mensagens, usuários ativos, vazão, latência, fila de saída). Apps também querem métricas próprias
no mesmo lugar. O LumaBot quer custo, tokens e latência por modelo de IA, no dashboard e no
Grafana. Se isso ficar em cada app, cada um reescreve a agregação, o armazenamento e a exportação,
e as métricas do kernel ficam sem dono.

Alternativas consideradas:

- **Manter o D82 e pôr métricas e dashboard no app.** Funciona para a Luma, mas não é reutilizável.
- **Métricas dentro do core** (agregação, storage, `/metrics`). O core passaria a decidir
  retenção, baldes e formato de exportação, que é escolha de quem consome (ADR 0011).
- **OpenTelemetry SDK.** Dependência pesada para um processo único que também quer persistir
  agregados no próprio storage.

## Decisão

- **O kernel publica dois plugins oficiais**, em `packages/`:
  - `@usebridger/plugin-metrics`;
  - `@usebridger/plugin-dashboard`.

  Os demais plugins da Luma seguem no LumaBot, como diz o D82.
- **O core só emite** (D102). O `plugin-metrics` observa `message.handled` e `outbound.sent`, lê
  `ctx.stats()` e agrega.
- **Serviço `metrics`**, com `counter`, `observe` e `query`, e o ponto `metrics.exporters`, lido só
  no flush. Os plugins do app publicam as próprias métricas nele, e o dashboard e a exportação as
  recebem sem integração própria. Valores derivados, como custo em dólar, são calculados na
  consulta.
- **Agregação em memória, flush periódico.** Os baldes diários são gravados com `increment` num
  flush por `setInterval` parado pelo `ctx.signal`, com flush final no teardown. Nunca há gravação
  por mensagem. O `scheduler.every` não serve aqui: cada chamada cria uma série nova.
- **Histograma com limites fixos** no plugin. Os percentis são calculados na consulta.
- **`GET /metrics`** no formato Prometheus, servido pelo HTTP do core (ADR 0018), a partir do
  agregado em memória.
- **Retenção** configurável, padrão de 90 dias.
- **Nenhum dado pessoal sai da memória.** O serviço rejeita rótulo com id de chat ou de usuário e
  limita as séries por métrica. Usuários e grupos ativos por dia saem de um conjunto de HMAC em
  memória, com chave aleatória diária que nunca é persistida. Só a contagem é gravada.
- **Dashboard.** Mostra QR, status, logs, config, enable/disable e as métricas: painéis fixos para
  as do kernel e uma seção genérica para qualquer métrica registrada. O que é específico de um
  app, como o deploy de produção da Luma, fica no app.
- **Fora agora:** tracing, HLL, MAU e exportação OTLP. O OTLP pode entrar como um
  `metrics.exporters` de terceiro ou como um pacote futuro.

## Consequências

- O kernel volta a ter plugins para manter, versionar e documentar. Os dois validam a API pública
  como consumidores reais, como o D19 previa.
- As issues do M5-4 (dashboard) passam do LumaBot para o `usebridger`, como o D80 fez com as do
  kernel.
- Um restart no meio do dia superestima os usuários ativos daquele dia.
- Mudar os limites do histograma é uma mudança no plugin, sem tocar no core. Os baldes já
  gravados ficam com os limites antigos.
