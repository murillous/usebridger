---
"@usebridger/plugin-metrics": minor
---

Métricas do kernel embutidas: o plugin observa `message.handled` e `outbound.sent` (mensagens tratadas, latência de tratamento, envios), conta usuários e grupos ativos por dia via HMAC com chave diária descartável (só a contagem é gravada) e expõe `GET /metrics` no formato de texto do Prometheus, com contadores, histogramas e gauges das filas (`ctx.stats()`).
