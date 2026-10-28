---
'@usebridger/core': minor
---

Auditoria pela API (ADR 0133), com a permissão `audit.read`: `GET /api/audit` consulta os eventos
com filtros de período, ator, ação, alvo e resultado e cursor `after`; `GET /api/audit/export`
exporta os mesmos filtros em CSV ou JSON, em stream, e grava `kernel.audit.export` na auditoria;
`POST /api/audit/verify` confere a cadeia de hash. O `onBehalfOf` do ator aparece nas linhas.
Evento de log novo: `audit.export.failed`.
