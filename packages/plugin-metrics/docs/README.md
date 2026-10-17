# @usebridger/plugin-metrics — documentação

Plugin oficial que provê o serviço `metrics`
([ADR 0107](../../../docs/adr/0107-plugins-oficiais-de-metricas-e-dashboard.md)). Este pacote
traz o serviço; as métricas do kernel e o `GET /metrics` Prometheus entram em outra etapa
(issue #149).

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

## Limites conhecidos

- O que está só em memória se perde se o processo morrer antes do flush (até `flushIntervalMs`).
  O flush final roda no `teardown`, que o core não executa se o bot parar com o prazo
  (`teardownTimeoutMs`) esgotado: nesse caso o agregado ainda não gravado se perde.
- O `query` espera o flush em andamento e refaz a leitura se um flush rodar durante ela, para não
  contar um dado em dobro nem perdê-lo.
- O dia de uma amostra é o UTC do momento da chamada.
