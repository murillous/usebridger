# @usebridger/plugin-metrics

## 0.3.0

### Minor Changes

- 227bd98: Logs pelo contrato do ADR 0118 (#230): cada linha sai com `event` (`baileys.*`, `web.*`, `dashboard.*`, `metrics.*`, e `transport.handler.failed` nos dois transports), mensagem fixa e os valores em campos. O `plugin-dashboard` deixa de escrever o prefixo `dashboard:` na mensagem (o binding `plugin` já diz de onde vem), e o `plugin-metrics` passa a logar o erro em `err`, com mensagem e stack. A lista dos eventos está em `docs/log-events.md` do core.
  
  No `metrics.prometheus.name-collision`, o campo `name` passa a `metric`. Os pacotes usam `log.event`, que existe a partir do `@usebridger/core` 0.10.0: use o core 0.10.0 ou mais novo (nos quatro pacotes, a dependência já sai como `^0.10.0`).
- f7f5501: `catalog()` e `query` pela API do core (ADR 0135): `GET /api/plugins/metrics/catalog` e
  `GET /api/plugins/metrics/query`, com `metrics.read`. `where` vai como `rótulo:valor` repetido e
  `groupBy` por vírgula; intervalo inválido é 400 e o último balde do histograma sai com
  `"le": "+Inf"`. O `GET /metrics` do Prometheus não muda.
- c49f69d: Histórico por hora e por dia no storage do bot, a partir do delta da registry do `prom-client`
  (ADR 0121, #237). O caminho quente continua com uma escrita só.
  
  - **Flush** a cada `flushIntervalMs` (padrão `60000`) e no `stop`/reload: o delta de contadores e
    histogramas (baldes não cumulativos, `sum`, `count`) vai com `increment` nas coleções `hourly`
    e `daily`; o gauge grava `last` e `max` do período. Gravação que falha fica pendente para o
    flush seguinte, sem somar duas vezes.
  - **Coleção `catalog`** com o descritor de cada métrica (`name`, `type`, `help`, `labelNames`,
    `buckets`, `owner`).
  - **Configs novas:** `flushIntervalMs`, `timeZone` (IANA, padrão `UTC`, também na virada dos
    ativos do dia) e `retention: { hourDays: 7, dayDays: 90 }`.
  - Os ativos do dia (`bridger_active_users`, `bridger_active_groups`) e a fila de saída
    (`bridger_outbound_pending`, somada) vão para o histórico como gauges amostrados no flush.
  - **Quebra no `metrics.exporters`:** o snapshot traz só o que o flush gravou, e as linhas trocam
    `day` por `granularity` (`'hour' | 'day'`) e `period`. O histograma traz `buckets` como mapa
    limite → contagem não cumulativa, sem `p50`/`p95`/`p99`. Exportado o tipo `Granularity` e o
    `GaugeRow`.
  - Eventos de log novos: `metrics.flush.failed`, `metrics.write.failed`, `metrics.purge.failed`,
    `metrics.catalog.write-failed`, `metrics.sample.failed`, `metrics.exporter.failed` e
    `metrics.exporters.list-failed`.
- d541c5c: O serviço `metrics` passa a ser uma camada fina sobre o `prom-client`, com uma `Registry` por bot
  (ADR 0121). Quebra a API:
  
  - Entram `counter({ name, help, labelNames })`, `histogram({ ..., buckets? })` e
    `gauge({ ... })`, que devolvem um handle com `inc`, `observe` e `set`. Os rótulos são tipados
    pelo `labelNames`; a declaração valida nome (`_total` no contador, `process_`/`nodejs_`
    reservados), rótulos e baldes, e a mesma especificação devolve o mesmo handle.
  - Saem `counter(nome, rótulos, valor)`, `observe`, `gauge(nome, ...)`, `query`, `names`,
    `ownerOf`, `HISTOGRAM_BUCKETS` e o tipo `MetricsRange`. `query` e o catálogo voltam reformulados.
  - As métricas do kernel mudam de nome: `bridger_messages_handled_total`,
    `bridger_message_handle_duration_seconds` (em segundos) e `bridger_outbound_sent_total`.
    `bridger.outbound.pending` e `bridger.active.*` deixam de ser gravados; os gauges ao vivo do
    `/metrics` seguem.
  - O `GET /metrics` sai do `registry.metrics()`, com `# HELP` e `# TYPE` em todas as métricas.
  - O plugin não grava mais no storage até o histórico voltar: saem o flush, as configs
    `flushIntervalMs` e `retentionDays` e os eventos de log `metrics.flush.failed`,
    `metrics.write.failed`, `metrics.purge.failed`, `metrics.exporter.failed`,
    `metrics.exporters.list-failed`, `metrics.outbound.sample-failed`, `metrics.active.sync-failed`
    e `metrics.prometheus.name-collision`.
- b906a73: Leitura do histórico no serviço `metrics` (ADR 0121, #238).
  
  - **`query({ name, from, to, granularity, where?, groupBy? })`** agrega o gravado com o delta
    ainda não gravado, no período corrente, na fila do flush (nada conta em dobro nem se perde).
    `where` filtra por igualdade de rótulo; `groupBy` soma pelos rótulos pedidos (`[]` é o total;
    ausente, uma linha por série). Intervalo inválido ou fora da retenção rejeita com `TypeError`
    na hora, sem esperar o flush.
  - Linhas novas `QueryRow` (`CounterQueryRow`, `HistogramQueryRow`, `GaugeQueryRow`): o histograma
    traz `buckets` como `{ le, count }[]` (último `le` em `Infinity`) e `p50`/`p95`/`p99`
    interpolados como o `histogram_quantile` do Prometheus; o gauge agrupado usa o `max` dos
    máximos e a soma do `last` mais novo de cada série.
  - **`catalog()`** lista as métricas vivas e as que só existem no histórico (`MetricDescriptor`,
    com `owner` e `live`), em ordem de `name`.
  - O `last` do gauge passa a gravar `at` (instante do flush em ms) na `hourly` e na `daily`.
  - Exportados `MetricQuery`, `QueryRow`, `CounterQueryRow`, `HistogramQueryRow`, `GaugeQueryRow`
    e `MetricDescriptor`.
  - **Quebra:** `MetricsService` ganha `query` e `catalog` obrigatórios; quem implementa a
    interface (um mock, por exemplo) precisa dos dois.
- d4a74dc: Métricas do runtime do Node (#239).
  
  - **`GET /metrics`** traz o `collectDefaultMetrics` do `prom-client` (`process_*`, `nodejs_*`):
    uma registry por processo, criada no primeiro bot com o runtime ligado e reaproveitada por bots
    novos e reloads. O último bot a parar desliga o coletor. Falha ao lê-la vai
    para o log (`metrics.runtime.scrape-failed`) e o resto do `/metrics` sai.
  - **Histórico:** gauges `bridger_runtime_rss_bytes`, `bridger_runtime_heap_used_bytes`,
    `bridger_runtime_eventloop_lag_p99_seconds`, `bridger_runtime_cpu_ratio` e
    `bridger_runtime_active_handles`, amostrados no flush com fonte própria.
  - Config nova `runtime`: `enabled` (padrão `true`), `eventLoopMonitoringPrecision` (padrão `10`)
    e `gcDurationBuckets`. A de quem cria a registry vale enquanto ela vive; config divergente gera
    `metrics.runtime.config-ignored` (`warn`) uma vez.
  - O serviço recusa declarar métrica com prefixo `bridger_runtime_`, reservado aos gauges acima.
- 06a49fe: `scrapeToken` no `GET /metrics` (#240).
  
  - Config nova `scrapeToken` (`secret()`, mín. 16 caracteres): com ela, o `/metrics` inteiro exige
    `Authorization: Bearer <token>`, comparado em tempo constante. Falta, esquema diferente ou token
    errado respondem `401` genérico, sem registrar o cabeçalho recebido.
  - Sem token a rota segue aberta e o boot registra `metrics.scrape.open` (`warn`) com o caminho.
  - Doc de implantação com Traefik e Grafana Alloy.

### Patch Changes

- a36bc23: Documentação revisada contra o código: páginas e comentários da API sem referências internas de decisão, mais exemplos e as lacunas preenchidas (Telegram, referência de mídia, rotas da API, eventos de log).
- 09738dc: Rastreio de usuários e grupos ativos mais barato por mensagem: a chave diária do HMAC vira
  `KeyObject` uma vez por dia, em vez de ser convertida a cada `createHmac`. O hash e a garantia
  de privacidade não mudam.
- 33f1d9b: O handle passa a recusar rótulo com cara de id pessoal pelo `isPersonalId` do core, no lugar do regex local: o log e as métricas usam a mesma regra. O comportamento não muda (`TypeError` no valor reconhecido).
- Updated dependencies [9a3a657]
- Updated dependencies [f4316ad]
- Updated dependencies [1d4cb96]
- Updated dependencies [aabf039]
- Updated dependencies [227bd98]
- Updated dependencies [184c8cb]
- Updated dependencies [87041b4]
- Updated dependencies [0b340df]
- Updated dependencies [18c56f3]
- Updated dependencies [cc35cbb]
- Updated dependencies [ede77ef]
- Updated dependencies [ae1e2b9]
- Updated dependencies [1c176d8]
- Updated dependencies [f7f5501]
- Updated dependencies [14c3f0c]
- Updated dependencies [b8b6b6e]
- Updated dependencies [6ab377b]
- Updated dependencies [0889b0c]
- Updated dependencies [a36bc23]
- Updated dependencies [48d7580]
- Updated dependencies [0a4c8cd]
- Updated dependencies [3cc14d5]
- Updated dependencies [abc53c7]
- Updated dependencies [48ceea9]
- Updated dependencies [e0bcb8b]
- Updated dependencies [ab54782]
- Updated dependencies [25b0caa]
- Updated dependencies [b7359b5]
- Updated dependencies [6681792]
- Updated dependencies [925a198]
  - @usebridger/core@0.10.0

## 0.2.0

### Minor Changes

- 7996b2a: Serviço `metrics` com escopo por plugin (ADR 0112): `ownerOf(nome)` devolve o plugin que gravou a métrica primeiro (`core` para o kernel) e o dono sai com o plugin. Novo `gauge(nome, rótulos, valor)` (último valor e máximo do dia, ADR 0113) e a métrica `bridger.outbound.pending`, a fila de saída amostrada a cada flush. Quebra de tipo: `MetricRow` ganhou o membro `GaugeRow`, e quem consome a união (`switch` em `type`, exportador) precisa tratar o caso novo; `MetricsService` ganhou `gauge` e `ownerOf`, obrigatórios para quem o implementa.

### Patch Changes

- Updated dependencies [f707794]
- Updated dependencies [c26a895]
- Updated dependencies [201c06a]
- Updated dependencies [c095ec7]
- Updated dependencies [5ef42f6]
- Updated dependencies [a784db1]
  - @usebridger/core@0.9.0

## 0.1.0

### Minor Changes

- 7c142d8: `MetricsService.names(range)` lista as métricas com dados no intervalo (persistidas ou em memória), para quem precisa descobrir métricas de outros plugins, como o dashboard.
- 59476b8: Métricas do kernel embutidas: o plugin observa `message.handled` e `outbound.sent` (mensagens tratadas, latência de tratamento, envios), conta usuários e grupos ativos por dia via HMAC com chave diária descartável (só a contagem é gravada) e expõe `GET /metrics` no formato de texto do Prometheus, com contadores, histogramas e gauges das filas (`ctx.stats()`).
- ed626b8: Novo pacote `@usebridger/plugin-metrics`: o serviço `metrics` (`counter`, `observe`, `query`) com agregação em memória, flush periódico em baldes diários (`Collection.increment`), histograma de 5 ms a 30 s com p50/p95/p99 na consulta, retenção configurável e o ponto de extensão `metrics.exporters` (ADR 0103).

### Patch Changes

- Updated dependencies [d79e8af]
- Updated dependencies [bf58cef]
- Updated dependencies [59f6646]
- Updated dependencies [9ad8550]
- Updated dependencies [740fed1]
- Updated dependencies [f65c4fa]
- Updated dependencies [97642b6]
- Updated dependencies [8232a57]
- Updated dependencies [36a9796]
  - @usebridger/core@0.8.0
