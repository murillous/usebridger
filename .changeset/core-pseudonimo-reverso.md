---
'@usebridger/core': minor
---

Pseudônimo de volta ao id (ADR 0132): com a `BRIDGER_SECRET_KEY`, o bot guarda cada par
`pseudônimo → id` cifrado no storage, e `GET /api/pseudonyms/{pseudonym}` devolve o id real a quem
tem a permissão nova `pseudonyms.resolve` (owner e admin). Toda consulta grava
`kernel.pseudonym.resolve` na auditoria, sem o id. Evento de log novo:
`bot.pseudonym.map-failed`. Os logs continuam só com o pseudônimo.
