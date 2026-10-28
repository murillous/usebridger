---
"@usebridger/core": patch
---

Trilha cobre edições e fila cheia (#246). `message.edited` gera `message.received` e `message.handled` (com `route: 'edit'`); a espera que vence com a fila do chat cheia emite `step.expired`. `trail` inválido lança `BotConfigError`, não `TypeError`.
