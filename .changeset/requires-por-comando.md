---
'@usebridger/core': minor
---

Comando com `requires: [...]` exige as capabilities só dele. No bot, sem alguma delas, o comando não é registrado: fica fora do roteador, do `ctx.commands.list()` e do menu nativo, com um log `info`, e o resto do plugin sobe normalmente (ADR 0090).
