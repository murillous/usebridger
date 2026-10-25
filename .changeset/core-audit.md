---
'@usebridger/core': minor
---

`ctx.audit` (ADR 0122): `record` síncrono com ator do contexto, redação de `details` e prefixo de
`action` validado; fila com dreno e cadeia HMAC-SHA256 na coleção `audit` do kernel; `query` e
`verify` para plugins admin; `verifyAudit` para o script do app; sinal de observador
`audit.dropped` e os eventos de log `audit.flush.failed` e `audit.dropped`.
