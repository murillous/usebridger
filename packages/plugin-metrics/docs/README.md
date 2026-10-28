# @usebridger/plugin-metrics — documentação

Plugin oficial que provê o serviço `metrics`, mede o kernel sozinho e expõe o `GET /metrics`
Prometheus. O serviço é uma camada fina sobre o [`prom-client`](https://github.com/siimon/prom-client), com as
métricas declaradas antes do uso.

O plugin grava o histórico por hora e por dia no storage do bot, a partir do delta da registry, e
o serviço lê esse histórico já agregado (`query`, `catalog`; ver Ler).

## Escrever

Carregue `metrics` no bot e declare `dependsOn: { metrics: '*' }` no plugin que o consome.
Declare as métricas no `setup` e guarde o handle:

```ts
const m = ctx.services.get('metrics'); // tipo MetricsService, vem do import do pacote

const tokens = m.counter({
  name: 'ai_tokens_total',
  help: 'Tokens consumidos',
  labelNames: ['model', 'kind'],
});
const latency = m.histogram({
  name: 'ai_latency_seconds',
  help: 'Latência da chamada ao modelo',
  labelNames: ['model', 'ok'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30], // opcional
});
const queue = m.gauge({ name: 'ai_queue_size', help: 'Pedidos na fila', labelNames: [] });

tokens.inc({ model, kind: 'input' }, usage.inputTokens); // valor padrão 1
latency.observe({ model, ok: 'true' }, durationMs / 1000);
queue.set({}, pending);
```

- O tipo dos rótulos sai do `labelNames`: rótulo não declarado não compila e lança `TypeError`
  em runtime. Rótulo declarado pode faltar na chamada e fica ausente na série.
- O valor precisa ser número finito `>= 0`, senão `TypeError` (o gauge também).
- O valor do rótulo é texto. A ordem das chaves na chamada não cria série nova.

### Regras da declaração

Declaração inválida lança `TypeError`:

- `name` segue `^[a-zA-Z_:][a-zA-Z0-9_:]*$`, com a unidade no nome (`_seconds`, `_bytes`). Tempo
  vai em segundos, a convenção do Prometheus.
- O contador termina em `_total`.
- Os prefixos `process_`, `nodejs_` e `bridger_runtime_` são reservados ao runtime do Node.
- `help` é texto não vazio.
- `labelNames` segue `^[a-zA-Z_][a-zA-Z0-9_]*$`, sem repetição. Histograma não aceita `le`, o
  rótulo dos baldes.
- `buckets` são finitos e crescentes. Sem `buckets`, vale o padrão do `prom-client`
  (`0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10`).
- Os nomes dos gauges ao vivo do kernel (abaixo) não podem ser declarados.

### Redeclaração e dono

- A mesma especificação (tipo, `help`, `labelNames` na mesma ordem e `buckets`) devolve o mesmo
  handle, também a outro plugin. Especificação diferente para o mesmo nome lança `TypeError`.
- O serviço tem escopo por quem chama:
  o dono de uma métrica é o primeiro plugin que a declarou. O que o próprio plugin-metrics declara
  tem o dono `core`.
- Quando um plugin sai (reload ou disable), ele deixa de declarar as métricas dele. Se outro
  plugin declarou a mesma métrica, ela segue no `/metrics` e esse plugin vira o dono. Sem ninguém,
  a métrica sai do `/metrics` e volta zerada na próxima declaração, como no `setup` do reload.

O dono ainda não sai na API pública; ele vai para a coleção `catalog` (abaixo) e volta na
leitura com o `catalog()`.

## Dado pessoal

O handle lança `TypeError` quando um valor de rótulo é texto que parece id de chat ou de usuário,
pelo reconhecedor `isPersonalId` do core (JID, telefone, id numérico longo). A checagem olha só os
**valores** dos rótulos, não os nomes. É heurística de formato: os falsos positivos e negativos
estão na [doc do logger do core](../../core/docs/logger.md#pseudônimo-do-usuário). Um id opaco fora desses
formatos passa: quem usa o serviço é quem responde por não pôr id como rótulo.

## Limite de séries

Cada combinação de rótulos é uma série. Passado `maxSeriesPerMetric`, a escrita numa série
**nova** é descartada e o plugin registra um `warn` (`metrics.series.overflow`, uma vez por
métrica); as séries que já existem seguem somando. O limite vale para a vida da registry: só
recomeça no restart ou reload do plugin. Rótulo de cardinalidade alta (ids, textos livres) esgota
o limite cedo.

## Config

Pela config do plugin (`pluginConfig.metrics`):

| Campo | Padrão | O que faz |
| --- | --- | --- |
| `flushIntervalMs` | `60000` (mín. `1000`) | Intervalo do flush do histórico, em ms |
| `timeZone` | `UTC` | Fuso IANA da virada da hora e do dia; fuso desconhecido recusa a config |
| `retention.hourDays` | `7` | Dias mantidos na coleção `hourly` |
| `retention.dayDays` | `90` | Dias mantidos na coleção `daily` |
| `maxSeriesPerMetric` | `1000` | Limite de séries por métrica |
| `runtime.enabled` | `true` | Liga as métricas do runtime do Node neste bot ([Runtime do Node](#runtime-do-node)) |
| `runtime.eventLoopMonitoringPrecision` | `10` (mín. `1`) | Resolução do atraso do event loop, em ms |
| `runtime.gcDurationBuckets` | padrão do `prom-client` | Baldes do histograma de GC, em segundos |
| `scrapeToken` | ausente (rota aberta) | Segredo (`secret()`, mín. 16 caracteres) exigido no `GET /metrics` ([Autenticação](#autenticação)) |

## Histórico

### Flush

A cada `flushIntervalMs` o plugin lê a registry e grava no storage o que mudou desde o flush
anterior. O caminho quente continua com uma escrita só, no `prom-client`. O `stop` e o reload do
plugin param o intervalo e fazem um flush final, então nada se perde entre o último flush e a
saída. Os flushes ficam em fila, nunca dois ao mesmo tempo.

- **Contador e histograma:** o delta é o valor da registry menos o último gravado, por série. O
  histograma grava cada balde **não cumulativo** (campo `le:<limite>`, com `le:+Inf`), mais `sum`
  e `count`. O delta vai com `increment` no período da hora **e** no do dia.
- **Gauge:** o handle guarda o último valor e o máximo desde o flush anterior. O flush grava `last`
  (sobrescreve) e `max` (sobe, nunca desce) nos dois períodos. Gauge sem `set` desde o flush
  anterior não grava nada.
- **Gravação que falha** fica pendente, com `metrics.write.failed` (`error`, `{ metric, err }`) no
  log, e entra no flush seguinte. Cada nível (hora e dia) tem o seu pendente: o que já foi gravado
  num nível não soma de novo.
- **Métrica que sai** (o dono saiu e ninguém mais a declarou) tem o delta que faltava gravado no
  flush seguinte. Ela volta zerada na redeclaração, com base nova, sem somar em dobro.
- **Restart e reload** recomeçam a registry do zero, e a base do delta junto: o histórico continua
  somando de onde parou.

O plugin também amostra, a cada flush, três gauges fora do serviço:

| Gauge no histórico | O que grava |
| --- | --- |
| `bridger_active_users` | Usuários ativos do dia até o flush (ver Ativos por dia) |
| `bridger_active_groups` | Grupos ativos do dia até o flush |
| `bridger_outbound_pending` | Fila de saída somadas as prioridades |

Falha ao ler as filas registra `metrics.sample.failed` e o resto do flush segue.

### Storage

Três coleções no namespace do plugin:

- **`hourly`** e **`daily`**: um documento por (métrica, período, série, campo), para o `increment`
  mexer num campo só. Campos: `metric`, `period`, `key` (a série, rótulos em ordem), `field`
  (`value`, `le:<limite>`, `sum`, `count`, `last` ou `max`), `labels` e `value`; o `last` do
  gauge leva também `at`, o instante do flush em ms. O `period` é o
  início do período no fuso da config: `YYYY-MM-DDTHH` na hora, `YYYY-MM-DD` no dia. Índices em
  `metric` e `period`.
- **`catalog`**: um descritor por métrica (`name`, `type`, `help`, `labelNames`, `buckets` ou
  `null`, `owner`), gravado na primeira declaração e regravado quando o dono muda. Uma métrica
  que só existe no histórico continua no catálogo, com os baldes que usava. Falha na gravação vai
  para o log (`metrics.catalog.write-failed`) e a próxima declaração regrava.

### Fuso

`timeZone` define a virada da hora e do dia no histórico e nos ativos do dia. Mudar o fuso vale do
flush seguinte em diante; o que já foi gravado não muda.

**Limite:** o delta cai no período em que o flush roda. Perto da virada, até `flushIntervalMs` de
dados pode ir para o período seguinte. O mesmo vale para o pendente de um flush que falhou.

### Retenção

No primeiro flush de cada dia (no fuso da config), o plugin apaga da `hourly` os períodos com mais
de `retention.hourDays` dias e da `daily` os com mais de `retention.dayDays`. Falha no corte vai
para o log (`metrics.purge.failed`) sem impedir o flush, e o flush seguinte tenta de novo.

### Ler

`query` agrega o histórico de uma métrica num intervalo, e `catalog` lista as métricas conhecidas.
Os dois rodam na fila do flush: um flush nunca acontece no meio de uma leitura, então nada é
contado em dobro nem perdido.

```ts
const m = ctx.services.get('metrics');

// Mensagens tratadas por dia, no total.
await m.query({
  name: 'bridger_messages_handled_total',
  from: '2026-10-01',
  to: '2026-10-24',
  granularity: 'day',
  groupBy: [],
});
// → [{ type: 'counter', period: '2026-10-01', labels: {}, value: 1520 }, …]

// p95 do tratamento por rota, hora a hora, só o que deu certo.
await m.query({
  name: 'bridger_message_handle_duration_seconds',
  from: '2026-10-24T00',
  to: '2026-10-24T23',
  granularity: 'hour',
  where: { status: 'ok' },
  groupBy: ['route'],
});
// → [{ type: 'histogram', period: '2026-10-24T00', labels: { route: 'command' },
//      count, sum, buckets: [{ le: 0.005, count: 3 }, …, { le: Infinity, count: 0 }],
//      p50, p95, p99 }, …]

// Consumo por modelo de uma métrica de app (ex.: tokens de IA).
await m.query({
  name: 'ai_tokens_total',
  from: '2026-10-01',
  to: '2026-10-24',
  granularity: 'day',
  groupBy: ['model'],
});
```

- **Intervalo:** `from` e `to` são inclusivos, no fuso da config. No dia, `YYYY-MM-DD`; na hora,
  `YYYY-MM-DDTHH` ou só o dia (vale da hora `00` à `23`). Formato inválido, data que não existe,
  `from` depois de `to`, granularidade que não é `hour` nem `day` ou `from` num dia mais antigo
  que a retenção do nível lançam `TypeError`.
- **O que entra:** o gravado no storage mais o que ainda não foi gravado (a registry menos o
  último flush, e o pendente de um flush que falhou), no período corrente.
- **`where`:** igualdade de rótulo; rótulo ausente na série não casa.
- **`groupBy`:** ausente, uma linha por série; `[]`, uma linha por período com `labels: {}`; com
  rótulos, soma as séries que têm os mesmos valores neles (rótulo ausente fica fora do `labels`).
- **Linhas** em ordem de período e de rótulos:
  - contador: `{ type: 'counter', period, labels, value }`;
  - histograma: `{ type: 'histogram', period, labels, count, sum, buckets, p50, p95, p99 }`, com
    `buckets` não cumulativos, somados antes do percentil, e o último `le` em `Infinity`;
  - gauge: `{ type: 'gauge', period, labels, last, max }`. Agrupado, vale o `max` dos máximos e, no
    `last`, a soma do `last` mais novo de cada série (a fila por prioridade vira o total).
- **Percentil:** interpolação linear dentro do balde, como o `histogram_quantile` do Prometheus.
  O limite inferior do primeiro balde é `0`, e o percentil que cai no `+Inf` vale o maior limite
  finito. Os limites são os da declaração (os do `catalog`) mais os gravados, então um balde
  vazio, que o flush não grava, ainda serve de limite inferior.
- **Limites diferentes** (redeclaração com outros `buckets` depois de um `release`): a linha usa a
  união dos limites. É aproximação: a interpolação toma como limite inferior o anterior da união,
  não o do balde original.

`catalog()` devolve um descritor por métrica, em ordem de `name`: `{ name, type, help,
labelNames, buckets?, owner?, live }`. Junta as declarações vivas no processo (`live: true`, com o
dono atual, `core` no kernel) com a coleção `catalog` (`live: false` e sem `owner` na métrica que
só existe no histórico). `buckets` só vem no histograma, com o padrão do `prom-client` quando a
declaração não passou.

### Pela API

Com `http` no bot, o plugin registra o `query` e o `catalog()` na API do core
([API](../../core/docs/api.md)), com a auth dela e a permissão `metrics.read` (owner,
admin e viewer). Sob `/api/plugins/metrics` na sessão `default` e
`/sessions/<sessão>/api/plugins/metrics` nas outras:

| Rota | Resposta |
| --- | --- |
| `GET /catalog` | `{ metrics }`, o `catalog()` |
| `GET /query` | `{ rows }`, o `query` |

O `GET /query` recebe o `MetricQuery` na query string:

- `name`, `from` e `to` como no serviço; `granularity` `hour` ou `day` (padrão `day`);
- `where=rótulo:valor`, repetido para mais de um rótulo;
- `groupBy=a,b` (rótulos por vírgula); `groupBy=` vazio é o total (`[]`); ausente, uma linha por
  série.

```sh
curl "http://localhost:3000/api/plugins/metrics/query?name=bridger_message_handle_duration_seconds&from=2026-10-24T00&to=2026-10-24T23&granularity=hour&where=status:ok&groupBy=route" \
  -H "Authorization: Bearer $BRIDGER_KEY"
```

As linhas são as do serviço, com uma diferença: JSON não tem `Infinity`, então o último balde do
histograma sai com `"le": "+Inf"`, como no Prometheus. O `TypeError` do serviço (intervalo
inválido, fora da retenção) vira 400 problem+json com a mensagem no `detail`.

Sem o plugin carregado, o core responde 404 problem+json nesses caminhos. O `GET /metrics` do
Prometheus segue à parte, com o `scrapeToken`, fora da auth da API.

### Exportadores

Plugins contribuem com o ponto `metrics.exporters` para mandar o histórico a outro lugar:

```ts
ctx.services.contribute('metrics.exporters', async ({ at, rows }) => {
  // rows: só o que este flush gravou, uma linha por série e por nível (hora e dia)
});
```

- `at` é o instante do flush (ISO 8601). Cada linha tem `metric`, `type`, `granularity`
  (`'hour'` ou `'day'`), `period` e `labels`, mais `value` (contador), `count`, `sum` e `buckets`
  (histograma, baldes não cumulativos por limite) ou `last` e `max` (gauge).
- Os valores são o delta gravado, não o acumulado. O que falhou ao gravar não entra; vai na
  linha do flush que o gravar.
- Erro de um exportador vai para o log (`metrics.exporter.failed`) e não impede os outros.
- Flush sem nenhuma linha gravada não chama exportador. Os gauges amostrados (ativos e fila)
  gravam em todo flush, então na prática todo flush chama.

## Métricas do kernel

O plugin assina `message.handled` e `outbound.sent` com `ctx.observe`
com rótulos de baixa cardinalidade e
nunca id de chat ou de usuário:

| Métrica | Tipo | Rótulos |
| --- | --- | --- |
| `bridger_messages_handled_total` | contador | `chatType`, `route`, `status`, `command` (se houver) |
| `bridger_message_handle_duration_seconds` | histograma (`0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30`) | `route`, `status` |
| `bridger_outbound_sent_total` | contador | `kind`, `status`, `chatType` (só em `ctx.reply`) |

Os gauges abaixo são lidos de `ctx.stats()` e do tracker de ativos a cada scrape. Eles ficam na
registry do bot, fora do serviço:

| Gauge | O que mede |
| --- | --- |
| `bridger_inbound_pending` | Tarefas aguardando na fila de entrada |
| `bridger_inbound_active_chats` | Chats com tarefa rodando |
| `bridger_outbound_pending{priority}` | Mensagens aguardando na fila de saída, por prioridade |
| `bridger_outbound_in_flight` | Envios em andamento |
| `bridger_outbound_paused` | `1` com a fila de saída pausada pela conexão caída |
| `bridger_active_users` | Usuários ativos hoje (no `timeZone`), desde o início do processo |
| `bridger_active_groups` | Grupos ativos hoje (no `timeZone`), desde o início do processo |

Os totais acumulados das filas (`processed`, `failed`, `dropped`...) não são expostos;
`bridger_messages_handled_total` e `bridger_outbound_sent_total` cobrem o volume e o resultado.

### Ativos por dia

Cada mensagem tratada põe o HMAC-SHA256 do id do remetente (e do chat, se grupo) num conjunto em
memória. A chave é aleatória, gerada por dia (no `timeZone`), nunca gravada nem logada; na virada
a chave e o conjunto são trocados. Só o tamanho dos conjuntos sai, nos gauges `bridger_active_*`
do `/metrics` e do histórico. No histórico, o `max` do dia é a contagem do último flush antes da
virada: o que chegou entre esse flush e a meia-noite não entra.

**Restart no meio do dia superestima:** o conjunto recomeça vazio e quem já tinha sido contado
conta de novo.

## Runtime do Node

CPU, memória, heap, atraso do event loop e GC do processo, para separar fila cheia de event loop
travado, achar vazamento num plugin e confirmar um OOM.

### No `/metrics`

O `collectDefaultMetrics` do `prom-client`, com os nomes padrão `process_*` e `nodejs_*` (os
dashboards prontos do Grafana funcionam sem ajuste), por exemplo `process_cpu_user_seconds_total`,
`process_resident_memory_bytes`, `nodejs_heap_size_used_bytes`,
`nodejs_eventloop_lag_p99_seconds` e `nodejs_gc_duration_seconds`. Os prefixos são reservados
ao runtime: o serviço recusa declarar `process_*`/`nodejs_*`, e também `bridger_runtime_*`,
os gauges do histórico.

- **Uma registry por processo**, criada quando o primeiro bot sobe com `runtime.enabled`. Bots
  novos e reloads do plugin a reaproveitam, sem coletor duplicado, e todo bot com o runtime ligado
  expõe os mesmos valores (o processo é um só).
- **O último bot a parar desliga o coletor**: o `monitorEventLoopDelay` e o observer de GC que o
  `collectDefaultMetrics` liga são desligados quando nenhum bot com o runtime ligado sobra. O
  próximo bot recria a registry, com a config dele e contadores do zero.
- **A config de quem cria a registry vale enquanto ela vive.** Um bot posterior com
  `eventLoopMonitoringPrecision` ou `gcDurationBuckets` diferente recebe
  `metrics.runtime.config-ignored` (`warn`) uma vez por registry.
- Falha ao ler a registry do runtime no scrape vai para o log (`metrics.runtime.scrape-failed`) e
  o resto do `/metrics` sai.

### No histórico

Gauges do kernel (dono `core`), amostrados a cada flush e gravados no storage de cada bot:

| Métrica | Fonte |
| --- | --- |
| `bridger_runtime_rss_bytes` | `process.memoryUsage().rss` |
| `bridger_runtime_heap_used_bytes` | `process.memoryUsage().heapUsed` |
| `bridger_runtime_eventloop_lag_p99_seconds` | `monitorEventLoopDelay` do plugin, zerado a cada flush |
| `bridger_runtime_cpu_ratio` | `process.cpuUsage()` entre dois flushes ÷ tempo de parede (passa de 1 com vários núcleos) |
| `bridger_runtime_active_handles` | `process.getActiveResourcesInfo().length` |

A fonte é do plugin, não a registry do `prom-client`, que zera o histograma do event loop a cada
leitura: o flush e o scrape não roubam a janela um do outro. O `query()` lê o valor corrente sem
fechar a janela. Uma fonte que falha vai para o log (`metrics.runtime.sample-failed`) e as outras
seguem.

`runtime.enabled: false` tira o runtime do `/metrics` e do histórico **daquele** bot; os outros bots
do processo não mudam.

## `GET /metrics`

Registrado no HTTP do core ([HTTP](../../core/docs/http.md)), sob a base do plugin: `/plugins/metrics/metrics` na sessão
`default` e `/sessions/<sessão>/plugins/metrics/metrics` nas outras. O corpo é o
`registry.metrics()` do `prom-client` (a do bot e, com o runtime ligado, a do processo), no formato de texto do Prometheus (`content-type` de
`registry.contentType`), com `# HELP` e `# TYPE` de cada métrica. Sem `http` no bot a rota não
existe (`metrics.http.missing`, `info` no log) e o resto do plugin segue.

- Cada bot (e cada `setup` do plugin) tem a sua `Registry`, nunca o `register` global do
  `prom-client`: dois bots no mesmo processo não se enxergam.
- As métricas de outros plugins aparecem também, com o nome declarado.
- `reload`/`restart` do plugin recomeçam a registry e o tracker de ativos: os contadores voltam a
  zero, o que o Prometheus trata como reset de contador, e os ativos do dia superestimam.

### Autenticação

Com `scrapeToken` na config, o `GET /metrics` inteiro (bot e runtime) exige
`Authorization: Bearer <token>`:

- O token é comparado em tempo constante (`timingSafeEqual` sobre o SHA-256 dos dois lados, o que
  também iguala o tamanho). O esquema `Bearer` não diferencia caixa.
- Cabeçalho ausente, esquema diferente ou token errado respondem `401` com o corpo
  `unauthorized` e `WWW-Authenticate: Bearer`, sem dizer o motivo. A recusa não registra o
  cabeçalho recebido.
- O campo é `secret()`:
  mascarado na leitura da config, censurado no log e editável pela camada de segredos.

Sem `scrapeToken` a rota fica aberta e o boot registra `metrics.scrape.open` (`warn`, uma vez por
`setup`) com o caminho da rota em `path`. Os dados não têm id pessoal, mas o `/metrics` divide o
servidor HTTP com as rotas que o proxy publica: em produção, configure o token.

### Implantação com Traefik e Grafana Alloy

O Alloy faz o scrape com o token e envia por `prometheus.remote_write` ao backend central:

```alloy
prometheus.scrape "bridger" {
  targets           = [{ __address__ = "bot:3000" }]
  metrics_path      = "/plugins/metrics/metrics"
  bearer_token_file = "/run/secrets/bridger_scrape_token"
  forward_to        = [prometheus.remote_write.central.receiver]
}
```

O arquivo do segredo tem o mesmo valor de `pluginConfig.metrics.scrapeToken`. Fora da sessão
`default`, o caminho é `/sessions/<sessão>/plugins/metrics/metrics`: um `prometheus.scrape` (ou
um alvo) por sessão.

Segunda camada recomendada: o roteador público do Traefik exclui o caminho do `/metrics`, e o
Alloy alcança o bot pela rede interna, sem passar pelo proxy:

```yaml
http:
  routers:
    bot:
      rule: "Host(`bot.exemplo.com`) && !PathPrefix(`/plugins/metrics/metrics`)"
      service: bot
```

Com sessões, exclua também `/sessions/<sessão>/plugins/metrics/metrics`.
