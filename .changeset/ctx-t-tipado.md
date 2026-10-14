---
'@usebridger/core': minor
---

`t` do contexto de comando (`CommandContext`, `MediaCommandContext`, `RejectContext`) aceita só as chaves de `messages` do plugin nos `commands` do `definePlugin`: chave que o plugin não declara vira erro de compilação, não `TypeError` na hora de responder. `command()` avulso continua com `string`, e helper tipado com o contexto genérico (`(ctx: CommandContext) => ...`) continua aceitando o contexto do plugin.
