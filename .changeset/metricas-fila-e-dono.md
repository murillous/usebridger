---
"@usebridger/plugin-metrics": minor
---

Serviço `metrics` com escopo por plugin (ADR 0116): `ownerOf(nome)` devolve o plugin que gravou a métrica primeiro (`core` para o kernel) e o dono sai com o plugin. Novo `gauge(nome, rótulos, valor)` (último valor e máximo do dia, ADR 0117) e a métrica `bridger.outbound.pending`, a fila de saída amostrada a cada flush. Quebra de tipo: `MetricRow` ganhou o membro `GaugeRow`, e quem consome a união (`switch` em `type`, exportador) precisa tratar o caso novo; `MetricsService` ganhou `gauge` e `ownerOf`, obrigatórios para quem o implementa.
