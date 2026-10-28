---
'@usebridger/plugin-metrics': minor
---

Histórico por hora e por dia no storage do bot, a partir do delta da registry do `prom-client`
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
