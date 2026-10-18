# @usebridger/plugin-metrics — documentação

Plugin oficial que provê o serviço `metrics`, mede o kernel sozinho e expõe o `GET /metrics`
Prometheus ([ADR 0107](../../../docs/adr/0107-plugins-oficiais-de-metricas-e-dashboard.md)).

## Usar

Carregue `metrics` no bot e declare `dependsOn: { metrics: '*' }` no plugin que o consome:

```ts
const m = ctx.services.get('metrics'); // tipo MetricsService, vem do import do pacote

m.counter('ai.tokens', { model, kind: 'input' }, 120); // value padrão 1, >= 0
m.observe('ai.latency', { model, ok: 'true' }, 340);   // em ms, >= 0
const rows = await m.query('ai.latency', { from: '2026-10-01', to: '2026-10-17' });
```

`query` devolve uma linha por dia e conjunto de rótulos, somando o que já foi gravado e o que
ainda está em memória (`from`/`to` inclusivos, `YYYY-MM-DD` em UTC):

- contador: `{ metric, type: 'counter', day, labels, value }`;
- histograma: `{ metric, type: 'histogram', day, labels, count, sum, p50, p95, p99, buckets }`.

`names({ from, to })` lista os nomes das métricas com dados no intervalo (persistidos ou em memória),
em ordem alfabética; é como o dashboard descobre métricas de outros plugins.

Uma métrica é contador ou histograma; usar o mesmo nome nos dois lança `TypeError`.

## Histograma

Limites fixos em ms, na constante `HISTOGRAM_BUCKETS`:
`5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000`, mais um balde `+Inf`.
Os percentis saem na consulta dos baldes e valem o **limite superior** do balde onde cai o
percentil (sem interpolação); acima de 30 s vale 30000.

## Dado pessoal

`counter` e `observe` lançam `TypeError` quando um valor de rótulo é texto que parece id de chat
ou de usuário. O core não expõe um reconhecedor, então a checagem é por formato: contém `@`
(JID `...@s.whatsapp.net`, `@g.us`, `@lid`), telefone (`+5511...` ou 7+ dígitos) ou id numérico
negativo longo. Um id opaco fora desses formatos passa: quem usa o serviço é quem responde por
não pôr id como rótulo. Rótulo que não é texto, valor negativo e valor não finito também lançam
`TypeError`.

A checagem olha só os **valores** dos rótulos, não os nomes. Limites conhecidos:

- Falsos positivos (lançam, mas não são pessoais): data compacta (`20261017`), CEP sem hífen,
  códigos e builds com 7+ dígitos, versões com `@` (`pkg@1.2.3`). Use outra forma (`2026-10-17`,
  `build-1234567`).
- Falsos negativos (passam, mas podem ser pessoais): telefone formatado (`(11) 99999-9999`) e
  ids opacos fora dos formatos acima.

## Limite de séries

Cada combinação de rótulos é uma série. Passado `maxSeriesPerMetric`, a amostra de uma série
**nova** é descartada e o plugin registra um `warn` (uma vez por métrica); as séries que já
existem seguem somando. O contador de séries vale para a vida do processo: não recomeça a cada dia, só no restart
ou reload do plugin. Rótulo de cardinalidade alta (ids, textos livres) esgota o limite cedo.

## Agregação, flush e armazenamento

`counter`/`observe` só mexem na memória. A cada `flushIntervalMs` (e uma última vez no
`teardown`) o agregado é gravado com `Collection.increment`
([ADR 0105](../../../docs/adr/0105-incremento-atomico-na-colecao.md)) na coleção `daily` do
plugin: um documento por métrica, dia (UTC), série e campo. Nunca há gravação por chamada, e o
intervalo é parado pelo `ctx.signal`. Gravação que falha volta ao agregado e é tentada no flush
seguinte (com `error` no log). Dois bots no mesmo storage somam nos mesmos documentos.

## Exportadores

Outro plugin contribui ao ponto `metrics.exporters`, lido só no flush:

```ts
ctx.services.contribute('metrics.exporters', async ({ at, rows }) => {
  await enviarParaOtlp(rows); // rows: só o que foi agregado desde o flush anterior
});
```

Erro de um exportador vai para o log e não impede os demais nem o flush. Flush sem novidade não
chama exportador.

## Config

Pela config do plugin (`pluginConfig.metrics`):

| Campo | Padrão | O que faz |
| --- | --- | --- |
| `flushIntervalMs` | `60000` | Intervalo do flush (mínimo 1000) |
| `retentionDays` | `90` | Dias mantidos; os mais antigos são apagados no primeiro flush de cada dia |
| `maxSeriesPerMetric` | `1000` | Limite de séries por métrica |

## Métricas do kernel

O plugin assina `message.handled` e `outbound.sent` com `ctx.observe`
([ADR 0106](../../../docs/adr/0106-observadores-do-core.md)) e grava no próprio agregado, com
rótulos de baixa cardinalidade e nunca id de chat ou de usuário:

| Métrica | Tipo | Rótulos |
| --- | --- | --- |
| `bridger.messages.handled` | contador | `chatType`, `route`, `status`, `command` (se houver) |
| `bridger.messages.handle_duration_ms` | histograma | `route`, `status` |
| `bridger.outbound.sent` | contador | `kind`, `status`, `chatType` (só em `ctx.reply`) |
| `bridger.active.users` / `bridger.active.groups` | contador (por dia) | nenhum |

### Ativos por dia

Cada mensagem tratada põe o HMAC-SHA256 do id do remetente (e do chat, se grupo) num conjunto em
memória. A chave é aleatória, gerada por dia (UTC), nunca gravada nem logada; na virada a chave
e o conjunto são trocados. Só a contagem é gravada: a cada flush entra no agregado o que cresceu
desde o flush anterior (delta), então a mesma contagem nunca soma duas vezes, e a contagem do
dia que acabou vai para o dia dele. O `query` só enxerga os ativos até o último flush.

**Restart no meio do dia superestima:** o conjunto recomeça vazio e quem já tinha sido contado
conta de novo.

## `GET /metrics`

Registrado no HTTP do core ([ADR 0020](../../../docs/adr/0020-http-unico-hono.md),
[HTTP](../../core/docs/http.md)), sob a base do plugin: `/plugins/metrics/metrics` na sessão
`default` e `/sessions/<sessão>/plugins/metrics/metrics` nas outras. Responde no formato de
exposição de texto do Prometheus (0.0.4). Sem `http` no bot a rota não existe (um `info` no log)
e o resto do plugin segue.

- Contadores e histogramas vêm do **acumulado desde o início do processo**, que não zera no
  flush (o flush só grava o delta). Histograma sai como `_bucket{le=...}` cumulativo, `_sum` e
  `_count` (unidade ms). Nomes saneados para `[a-zA-Z0-9_:]` (`bridger.messages.handled` vira
  `bridger_messages_handled`). Métricas de outros plugins aparecem também.
- Gauges lidos a cada scrape de `ctx.stats()`, para a saúde das filas: `bridger_inbound_pending`,
  `bridger_inbound_active_chats`, `bridger_outbound_pending{priority}`,
  `bridger_outbound_in_flight`, `bridger_outbound_paused`, e os ativos do dia
  `bridger_active_users` e `bridger_active_groups`. Os totais acumulados das filas
  (`processed`, `failed`, `dropped`...) não são expostos; `bridger_messages_handled` e
  `bridger_outbound_sent` cobrem o volume e o resultado. Os gauges não são gravados no flush.
- Nome saneado que colide com outra métrica do mesmo tipo (`a.b` e `a_b`) sai sob um único
  `# TYPE`; se o tipo for diferente, a segunda é **descartada do `/metrics`** com `warn` no log.
  Um rótulo `le` de histograma é renomeado para `exported_le` (o `le` é dos baldes).
- `reload`/`restart` do plugin recomeçam o tracker de ativos e os totais: os ativos do dia
  superestimam (quem já contou conta de novo) e os contadores voltam a zero, o que o Prometheus
  trata como reset de contador. O que já foi gravado no storage não se perde.
- **Sem autenticação** (autenticação é do plugin, `http.md`): os dados não têm id pessoal, mas
  proteja a rota no proxy se a instância é pública.

## Limites conhecidos


- O que está só em memória se perde se o processo morrer antes do flush (até `flushIntervalMs`).
  O flush final roda no `teardown`, que o core não executa se o bot parar com o prazo
  (`teardownTimeoutMs`) esgotado: nesse caso o agregado ainda não gravado se perde.
- O `query` espera o flush em andamento e refaz a leitura se um flush rodar durante ela, para não
  contar um dado em dobro nem perdê-lo.
- O dia de uma amostra é o UTC do momento da chamada.
