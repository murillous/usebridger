---
'@usebridger/core': minor
---

Filtro de auditoria por tipo de ator: `actorKind` (um ou vários) em `GET /api/audit`,
`GET /api/audit/export` e `ctx.audit.query`. Os eventos novos gravam `actorKind` no topo; os
anteriores continuam válidos na cadeia, mas não casam com o filtro.
