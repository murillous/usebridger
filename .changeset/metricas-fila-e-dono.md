---
"@usebridger/plugin-metrics": minor
---

Serviço `metrics` com escopo por plugin (ADR 0116): `ownerOf(nome)` devolve o plugin que gravou a métrica primeiro (`core` para o kernel) e o dono sai com o plugin. Novo `gauge(nome, rótulos, valor)` (último valor e máximo do dia, ADR 0117) e a métrica `bridger.outbound.pending`, a fila de saída amostrada a cada flush.
