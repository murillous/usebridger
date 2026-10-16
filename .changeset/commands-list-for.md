---
'@usebridger/core': minor
---

`ctx.commands.list({ for: message })` devolve só os comandos que o remetente pode rodar, com a mesma regra de papel do roteador (owner passa em todos, papel custom com prazo e fail-closed). O menu de ajuda deixa de esconder os comandos de `owner` e de papéis custom de quem pode usá-los. Fora do bot, o roteador ganha `allowed(ctx)`.
