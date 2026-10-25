---
'@usebridger/plugin-metrics': minor
---

O serviço `metrics` passa a ser uma camada fina sobre o `prom-client`, com uma `Registry` por bot
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
