---
'@usebridger/plugin-metrics': minor
---

`scrapeToken` no `GET /metrics` (#240).

- Config nova `scrapeToken` (`secret()`, mín. 16 caracteres): com ela, o `/metrics` inteiro exige
  `Authorization: Bearer <token>`, comparado em tempo constante. Falta, esquema diferente ou token
  errado respondem `401` genérico, sem registrar o cabeçalho recebido.
- Sem token a rota segue aberta e o boot registra `metrics.scrape.open` (`warn`) com o caminho.
- Doc de implantação com Traefik e Grafana Alloy.
