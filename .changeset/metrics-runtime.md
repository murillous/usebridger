---
'@usebridger/plugin-metrics': minor
---

Métricas do runtime do Node (#239).

- **`GET /metrics`** traz o `collectDefaultMetrics` do `prom-client` (`process_*`, `nodejs_*`):
  uma registry por processo, criada no primeiro bot com o runtime ligado e reaproveitada por bots
  novos e reloads. Ela vive até o fim do processo (o coletor não tem `stop`). Falha ao lê-la vai
  para o log (`metrics.runtime.scrape-failed`) e o resto do `/metrics` sai.
- **Histórico:** gauges `bridger_runtime_rss_bytes`, `bridger_runtime_heap_used_bytes`,
  `bridger_runtime_eventloop_lag_p99_seconds`, `bridger_runtime_cpu_ratio` e
  `bridger_runtime_active_handles`, amostrados no flush com fonte própria.
- Config nova `runtime`: `enabled` (padrão `true`), `eventLoopMonitoringPrecision` (padrão `10`)
  e `gcDurationBuckets`. A do primeiro bot vale para o processo; config divergente gera
  `metrics.runtime.config-ignored` (`warn`) uma vez.
