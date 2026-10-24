---
'@usebridger/plugin-dashboard': minor
---

Remove a seção de métricas do dashboard até a reescrita da M7: sai a rota `GET /api/metrics`, a
tela Métricas, os KPIs de hoje da Visão geral e a entrada Métricas da navegação, e o evento de log
`dashboard.metrics.read-failed`. O dashboard não importa mais o `@usebridger/plugin-metrics`. O
resto (QR, status, logs, config, plugins e abas) segue igual.
