---
'@usebridger/core': minor
---

Comando deixado de fora por `requires` ausente no transport (ADR 0090) agora aparece para o operador: o log sobe de `info` para `warn`, e a tabela de boot mostra o comando junto do plugin (`media  1.0.0  carregado; sem figurinha (send.sticker)`), em `warn`. Em `bot.plugins()`, a entrada `loaded` ganha `unregistered`, com `command` e `missing` de cada comando.
