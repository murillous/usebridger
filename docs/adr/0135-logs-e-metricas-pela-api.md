# ADR 0135 — Logs e métricas pela API

**Status:** Aceito (2026-10-27) · Usa a API do **D125**
([ADR 0125](0125-api-http-do-core-e-dashboard-cliente.md)), as rotas de plugin do **D126**
([ADR 0126](0126-rotas-da-api-de-plugin-sob-api-plugins.md)), o tempo real do **D129**
([ADR 0129](0129-conexao-e-tempo-real-pela-api.md)) e o `query`/`catalog()` do **D121**
([ADR 0121](0121-plugin-metrics-sobre-o-prom-client.md))

## Contexto

O ADR 0125 põe logs e métricas na API. O SSE (ADR 0129) já entrega o log ao vivo, mas quem abre a
tela não vê o que veio antes, e o dashboard antigo guardava esse histórico. As métricas têm
`query` e `catalog()` no serviço do `plugin-metrics`, que o kernel não conhece. Faltava decidir de
onde o histórico de logs sai, em que ordem pagina e quem é dono das rotas de métricas.

Alternativas consideradas:

- **Logs no storage**, como a auditoria. Daria histórico além do processo, mas grava cada linha de
  log, e o log durável já é do destino do logger (stdout, agregador). Seria um segundo pipeline de
  log, sem retenção nem índice pensados para isso.
- **Reaproveitar o buffer do SSE.** Ele mistura todos os tipos de evento e serve à retomada; um
  filtro por plugin varreria eventos de conexão e encolheria a janela de log.
- **Rotas de métricas no core**, lendo o serviço `metrics` quando existir. O core passaria a
  conhecer o contrato de um plugin, e a spec teria rotas que só funcionam com ele.

## Decisão

- **`GET /api/logs`** (`logs.read`) lê um buffer em memória das últimas 1000 linhas, alimentado
  pelo mesmo sinal `log` do SSE. Só existe com `BotConfig.http`.
- **Formato:** cada linha é o `data` do evento `log` do SSE (`{ level, time, message, fields }`),
  na resposta `{ logs, next? }`.
- **Ordem e cursor:** da mais nova para a mais antiga; `before` recebe o `next` da página anterior,
  um número de sequência do processo. `next` só vem quando há outra linha que casa, então o
  cliente não pede uma página vazia.
- **Filtros:** `level` como nível mínimo, `plugin` e `event` por igualdade com os campos da linha,
  `from`/`to` inclusivos por `time`, `limit` de 1 a 1000 (padrão 100).
- **Visibilidade do SSE:** a linha com o valor do QR ou do código de pareamento pede
  `connection.manage` também aqui. O filtro é o mesmo código nos dois caminhos.
- **Métricas são do `plugin-metrics`**, por `ctx.http.api`: `GET /api/plugins/metrics/catalog` e
  `GET /api/plugins/metrics/query`, com `metrics.read`. O `query` recebe `where` como
  `rótulo:valor` repetido e `groupBy` por vírgula (vazio é o total). O `TypeError` do serviço vira
  400. O `le: Infinity` do histograma sai como `"+Inf"`, porque o JSON não tem `Infinity`.
- **404 explicado:** caminho sob `/api/plugins/<nome>/` sem rota responde problem+json com o
  `detail` dizendo que a rota é do plugin e perguntando se ele está carregado.
- O `GET /metrics` do Prometheus segue como está, fora da auth da API (ADR 0121, #240).

## Consequências

- Quem abre o dashboard vê as últimas linhas sem ter de esperar log novo; depois de um restart,
  o histórico começa vazio.
- O buffer custa até 2000 referências de linha por bot (o corte é em lote), mesmo sem cliente.
- As rotas de métricas entram na spec só com o plugin carregado, e a do core continua sem saber
  dele.
- shortcut: o 404 explicado não confere se o plugin existe; um nome digitado errado leva a mesma
  pergunta.
