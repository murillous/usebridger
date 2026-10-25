---
'@usebridger/plugin-metrics': minor
---

Métricas do runtime do Node (#239).

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
