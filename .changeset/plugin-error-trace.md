---
"@usebridger/core": minor
---

O payload do `plugin.error` ganha o campo opcional `trace`: o trace (ADR 0120) da mensagem, request ou job em que o erro ocorreu, o mesmo da linha de log. Sem trace ativo, o campo fica ausente (#246).
