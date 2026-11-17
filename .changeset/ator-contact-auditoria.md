---
"@usebridger/core": minor
---

Auditoria: o remetente da mensagem vira o ator `contact` (id pseudonimizado) de tudo o que ela
dispara (middleware, comando, inclusive `background`, passo, botão e listeners), e o
`ctx.audit.record` do plugin sai com `via: <plugin>`. O core passa a gravar
`kernel.command.run` e `kernel.command.denied` para comandos com papel `owner` ou custom, sem os
argumentos (ADR 0140).

**Mudança de comportamento:** eventos gravados a partir de uma mensagem saíam com
`actor: { kind: 'plugin' }` e agora saem com `actor: { kind: 'contact' }`. Quem filtrava por
`actorId = <plugin>` deve filtrar por `via`. `setup`, jobs do scheduler e `onExpire` continuam com
o ator `plugin`.
