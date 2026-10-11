---
'@usebridger/core': minor
---

Comando com `background: true` roda o `run` fora da fila do chat: a próxima mensagem não espera por ele, e o `run` mantém `reply`, `signal` com o `timeoutMs`, a falha em `plugin.error`, o evento `command` e o `bot.settled()` (ADR 0087).
