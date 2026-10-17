---
"@usebridger/core": minor
---

`ctx.observe('log', fn)`: sinal com cada linha do logger do bot (`level`, `time`, `message`, `fields` com os bindings dos filhos), dentro do nível do logger e com os secrets mascarados. Log feito dentro de um observador de `log` não reentra no sinal (ADR 0109).
