---
'@usebridger/plugin-metrics': minor
---

`catalog()` e `query` pela API do core (ADR 0135): `GET /api/plugins/metrics/catalog` e
`GET /api/plugins/metrics/query`, com `metrics.read`. `where` vai como `rótulo:valor` repetido e
`groupBy` por vírgula; intervalo inválido é 400 e o último balde do histograma sai com
`"le": "+Inf"`. O `GET /metrics` do Prometheus não muda.
