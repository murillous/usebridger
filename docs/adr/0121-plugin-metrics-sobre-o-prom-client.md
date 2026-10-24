# ADR 0121 — `plugin-metrics` redesenhado sobre o `prom-client`

**Status:** Aceito (2026-10-24) · Substitui em parte o **D103**
([ADR 0103](0103-plugins-oficiais-de-metricas-e-dashboard.md)) (agregação, histograma, `/metrics`
e retenção) e o **D113** ([ADR 0113](0113-gauge-e-fila-de-saida-nas-metricas.md)) (gauge diário) ·
Usa **D112** ([ADR 0112](0112-servico-com-escopo-por-chamador.md)) e **D117**
([ADR 0117](0117-segredos-cifrados-editaveis-pelo-dashboard.md))

## Contexto

O `plugin-metrics` tem um agregador próprio: contadores, histogramas com baldes fixos em ms
(`HISTOGRAM_BUCKETS`) e gauges, gravados por dia em UTC (ADR 0103, ADR 0113). O `/metrics` é
montado à mão e o processo Node não é medido. A #228 propunha só pôr o `prom-client` ao lado do
agregador, para as métricas do runtime.

A M6 vai além: o `prom-client` passa a ser a base de tudo no plugin. Duas condições tornam isso
barato agora:

- o dashboard vai ser refeito do zero na M7, então nada aqui precisa ser compatível com o
  dashboard atual;
- nada consome os dados gravados, então não há migração.

As decisões abaixo dependem umas das outras e ficam num ADR só. As issues da M6 (#234 a #241)
citam as seções dele.

## Decisão

### Base e escrita

- **`prom-client` como base**, com uma `Registry` **por bot**, nunca o `register` global. Dois
  bots no mesmo processo não se enxergam (ADR 0003). O `/metrics` do bot sai da registry dele mais
  a registry do runtime.
- **API declarativa.** `m.counter({ name, help, labelNames })`,
  `m.histogram({ name, help, labelNames, buckets? })` e `m.gauge({ name, help, labelNames })`
  devolvem um handle com `inc(labels, value?)`, `observe(labels, value)` e `set(labels, value)`.
  - Rótulo declarado e não passado fica ausente na série, como o `statusCode` opcional do
    `ai-metrics`.
  - Substitui o `counter(nome, rótulos, valor)`, o `observe` e o `gauge` de hoje.
- **Nome Prometheus nativo em tudo** (API, storage e `/metrics`), sem traduzir ponto para `_`.
  Um nome só evita a tabela de tradução e a dúvida de qual dos dois procurar no Grafana.
  - A declaração valida `^[a-zA-Z_:][a-zA-Z0-9_:]*$` e exige o sufixo `_total` no contador.
  - Os prefixos `process_` e `nodejs_` ficam reservados ao runtime.
  - A unidade vai no nome (`_seconds`, `_bytes`).
- **Tempo em segundos**, a convenção do Prometheus. Os histogramas do kernel vão de ms para
  `_seconds`.
- **Baldes por métrica.** Sem `buckets`, vale o padrão do `prom-client` (`0.005 … 10` s).
- **Redeclaração:**
  - a mesma especificação (tipo, `help`, `labelNames`, `buckets`) devolve o mesmo handle, também
    vinda de outro plugin;
  - especificação diferente lança `TypeError`;
  - o dono é quem declarou primeiro (serviço com escopo, ADR 0112). A métrica sai no `release` do
    plugin dono e volta na próxima declaração.
- **Guardas no caminho quente:**
  - rótulo com cara de id pessoal lança `TypeError`;
  - o `maxSeriesPerMetric` descarta a série nova com um `warn` por métrica, uma vez só.

  O reconhecedor de id pessoal segue local no plugin; a troca pelo do core (#231) é a #241 (M6-9).

### Histórico

- **O histórico no storage do bot continua**, para o painel funcionar sem Prometheus externo.
- **Fonte: delta da registry no flush.** O flush lê o `prom-client`, subtrai o que já foi gravado
  e faz `increment`. Não há escrita dupla no caminho quente.
  - Limite: o delta cai no período do flush. Perto da virada, até `flushIntervalMs` de dados pode
    ir para o período seguinte.
  - A leitura soma o que foi gravado com o delta ainda não gravado.
- **Dois níveis gravados**, coleções `hourly` e `daily`, com `increment` nas duas a cada flush. Sem
  job de consolidação.
- **`timeZone`** (IANA, padrão `UTC`) define a virada do dia e da hora. Mudar o fuso vale dali em
  diante, sem regravar o que já existe.
- **Retenção:** `retention: { hourDays: 7, dayDays: 90 }`, com o corte no primeiro flush de cada
  dia.
- **Gauge:** o handle guarda o `max` desde o flush anterior, e o flush grava `last` e `max` do
  período. A API pública não ganha `collect`.
- **Ativos do dia:** o conjunto de HMAC com chave diária continua (ADR 0103). A contagem vira gauge
  diário (`bridger_active_users`, `bridger_active_groups`) em vez de contador por delta. O restart
  no meio do dia segue superestimando.
- **Exportadores:** o `metrics.exporters` continua recebendo, em cada flush, o snapshot das linhas
  gravadas.

### Leitura

- **`query({ name, from, to, granularity: 'hour' | 'day', where?, groupBy? })`:**
  - `where` filtra por igualdade de rótulo;
  - `groupBy` soma as séries pelos rótulos pedidos (`[]` = total);
  - no histograma, soma os baldes antes do percentil;
  - no gauge, usa o `max` dos máximos e o `last` mais recente.
- **Percentil interpolado**, como o `histogram_quantile` do Prometheus, para o painel e o Grafana
  mostrarem o mesmo número.
- **`catalog()`** substitui `names` e `ownerOf`. Traz os descritores: `name`, `type`, `help`,
  `labelNames`, `buckets` e dono. O descritor é persistido na primeira declaração, então uma
  métrica que só existe no histórico também aparece, com os baldes que usava.

### Runtime do Node

- **O `collectDefaultMetrics` roda numa registry própria**, um coletor por processo, criado na
  primeira vez que um bot sobe com `runtime.enabled`.
  - Vive até o fim do processo, porque a lib não tem `stop`.
  - A config do primeiro bot vale para todos.
  - `enabled: false` num bot só tira o runtime do `/metrics` dele.
- **Gauges `bridger_runtime_*` no histórico:** `rss_bytes`, `heap_used_bytes`,
  `eventloop_lag_p99_seconds`, `cpu_ratio` (entre dois flushes) e `active_handles`.
  - Fonte própria: `process.memoryUsage()`/`cpuUsage()` e um `monitorEventLoopDelay` do plugin.
  - A registry do runtime fica de fora porque o `prom-client` zera o histograma do event loop a
    cada leitura: flush e scrape roubariam a janela um do outro.

### `GET /metrics`

- **`scrapeToken` opcional**, tratado como segredo (ADR 0117).
  - Com token, exige `Authorization: Bearer <token>`, comparado com `timingSafeEqual`, e responde
    `401` sem dizer o motivo.
  - Sem token, a rota fica aberta e o boot registra um `warn`.

## Alternativas consideradas

- **Agregador próprio mais `prom-client` só para o runtime** (a proposta original da #228). Mantém
  dois modelos de métrica, os baldes fixos em ms e o `/metrics` montado à mão.
- **OpenTelemetry SDK** (`sdk-metrics`, `instrumentation-runtime-node` e `host-metrics`). Mais
  pesado, e o caminho até o storage do bot e o `/metrics` seria igual ou maior. Um exportador OTLP
  continua possível como `metrics.exporters` de terceiro (ADR 0103).
- **Manter a API inferida** (`counter(nome, rótulos, valor)`) e criar a métrica do `prom-client` no
  primeiro uso. Rejeitada: o `prom-client` fixa `labelNames` na criação, e o `help` sairia
  genérico.
- **Escrita dupla** (`prom-client` mais o agregador diário exato). Dobra o custo no caminho quente
  para corrigir só o deslize de até um `flushIntervalMs` na virada.
- **Granularidade de minuto com rebaixamento, ou só hora com job de consolidação.** Minuto
  multiplica as linhas por 60 sem uso na tela; o job de consolidação é uma peça a mais que pode
  falhar. Hora e dia gravados juntos cobrem o painel.
- **`collect` público no gauge, e exportador recebendo a registry.** Expõe o `prom-client` como
  contrato da API pública; o snapshot das linhas gravadas basta aos exportadores.
- **`scrapeToken` obrigatório.** Quebra o uso local e o Prometheus na mesma rede privada; o `warn`
  no boot deixa a escolha visível.

## Consequências

- **Quebra da API do serviço `metrics`** para plugins de terceiros: `counter`, `observe`, `gauge`,
  `names` e `ownerOf` saem; entram a declaração com handle, `query` com `granularity` e
  `catalog()`. Major do `@usebridger/plugin-metrics`.
- **O `ai-metrics` do LumaBot** precisa migrar: declarar as métricas no setup, renomear para o
  formato Prometheus (`_total`, `_seconds`) e passar os tempos para segundos.
- Os nomes das métricas do kernel mudam (de `bridger.*` para `bridger_*`, histogramas em
  `_seconds`). Painel e alertas do Grafana feitos sobre os nomes antigos precisam ser refeitos.
- Os dados gravados no formato antigo ficam órfãos. Não há migração, porque nada os consome.
- A seção de métricas do dashboard atual sai (#235, M6-3) e volta no dashboard novo da M7.
- O plugin ganha a dependência `prom-client`.
- O coletor do runtime é global ao processo: a config do primeiro bot vale para todos, e o coletor
  não para com o bot.
- Ainda vale do ADR 0113: a resolução do histórico é a do intervalo de flush (60 s por padrão), e
  picos mais curtos não aparecem.
