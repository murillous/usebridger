---
'@usebridger/core': minor
---

`ctx.react` no contexto de mensagem (middleware, comando, passo e listener) não rejeita mais num transport sem a capability `reactions`: resolve sem reagir e registra em `debug`. O `ctx.send.react` continua rejeitando com `UnsupportedError` (ADR 0093).
