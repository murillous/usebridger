---
"@usebridger/plugin-metrics": minor
---

Novo pacote `@usebridger/plugin-metrics`: o serviço `metrics` (`counter`, `observe`, `query`) com agregação em memória, flush periódico em baldes diários (`Collection.increment`), histograma de 5 ms a 30 s com p50/p95/p99 na consulta, retenção configurável e o ponto de extensão `metrics.exporters` (ADR 0107).
