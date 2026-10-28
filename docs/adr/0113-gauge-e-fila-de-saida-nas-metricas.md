# ADR 0113 — Gauge no serviço `metrics` e a fila de saída

**Status:** Aceito (2026-10-17) · Gauge diário: substituído em parte pelo **D121**
([ADR 0121](0121-plugin-metrics-sobre-o-prom-client.md)) · Detalha **D103** ([ADR 0103](0103-plugins-oficiais-de-metricas-e-dashboard.md))

## Contexto

A tela Métricas precisa de histórico da fila de saída (itens pendentes). O serviço só tinha
contador e histograma. Um histograma com baldes em ms lê a fila vazia como "p95 5", mostra "ms" onde
é contagem e, amostrado no envio, não vê fila pausada (sem envio, sem amostra).

## Decisão

- **`MetricsService.gauge(name, labels, value)`:** guarda por série e por dia o último valor e o
  máximo. Linha: `{ type: 'gauge', day, labels, last, max }`. Valor finito >= 0.
- **Persistência:** um documento por (métrica, dia, série) com `field: 'gauge'`, `value` = máximo e
  `last`. O flush lê e atualiza; o `query` mescla com a memória.
- **Exportadores e `/metrics`:** o gauge entra no snapshot dos exportadores e no scrape (valor
  `last`, `# TYPE gauge`), como as demais métricas (ADR 0103). A exceção é `bridger.outbound.pending`,
  que já sai ao vivo como `bridger_outbound_pending` e fica fora dos dois.
- **Fila de saída:** `bridger.outbound.pending`, gauge sem rótulos, amostrado de `ctx.stats()`
  (soma das prioridades) no timer de flush, não no envio. O painel de Métricas mostra o máximo por dia.
- **KPI ao vivo:** o dashboard lê `ctx.stats()` ele mesmo e entrega `outboundPending` no status
  (`GET /api/status` e WebSocket). Não depende do plugin-metrics.

## Consequências

- `MetricRow` ganha `GaugeRow`: quem faz `switch` sobre `type` precisa tratar o novo caso (minor).
- A resolução do histórico é a do intervalo de flush (60 s por padrão): picos mais curtos não
  aparecem.
