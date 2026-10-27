---
'@usebridger/core': minor
---

Histórico de logs pela API (ADR 0135): `GET /api/logs`, com `logs.read`, devolve as últimas 1000
linhas do processo no formato do evento `log` do SSE, da mais nova para a mais antiga, com filtros
`level` (mínimo), `plugin`, `event`, `from`/`to` e cursor `before`. Caminho sem rota sob
`/api/plugins/<nome>/` responde 404 problem+json explicando que a rota é do plugin.
