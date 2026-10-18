---
"@usebridger/plugin-dashboard": minor
---

Visão geral ganha o 5º KPI "Fila de saída", ao vivo pelo status (`outboundPending`), e Métricas troca "Envios por dia" pelo painel da fila de saída (máximo por dia, gauge). A coluna "Plugin" mostra o dono de cada métrica (`core` para o kernel), `GET /api/metrics` devolve `plugin` por métrica e a contagem de séries passa a ficar no texto, ao lado do nome.
