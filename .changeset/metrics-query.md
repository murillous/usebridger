---
'@usebridger/plugin-metrics': minor
---

Leitura do histórico no serviço `metrics` (ADR 0121, #238).

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
