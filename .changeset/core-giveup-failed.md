---
'@usebridger/core': minor
---

Erro fatal não derruba mais o painel (#194): o giveUp da reconexão (`fatal`, `auth-failed` sem pareamento, `replaced`, sessão a parear sem `clearSession`) leva o bot ao novo `BotState` `failed` (transport e filas parados; plugins e HTTP no ar) em vez de chamar `stop()`. `stop()` a partir de `failed` chega a `stopped`; `start()` rejeita.
