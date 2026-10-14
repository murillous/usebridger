---
'@usebridger/core': minor
---

`bot.plugins` ganha `disable(name)` e `enable(name)`, para desligar e ligar um plugin em execução sem gravar override na config. A cascata é a do `reload`: os dependentes descem junto e sobem depois. Um plugin desligado (por `disabledPlugins` ou por `disable`) recusa `reload` até ser ligado. `bot.plugins()` segue devolvendo a tabela de boot.
