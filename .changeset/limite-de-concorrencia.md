---
'@usebridger/core': minor
---

Comando com `concurrency: n` roda no máximo `n` execuções do `run` ao mesmo tempo no bot, somando todos os chats. A excedente espera a vez em ordem de chegada, a espera conta no `timeoutMs`, e a vaga só volta quando o `run` termina de fato (ADR 0088).
