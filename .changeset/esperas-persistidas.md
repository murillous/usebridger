---
'@usebridger/core': minor
'@usebridger/testing': minor
---

Esperas do `expectReply` que sobrevivem a restart: `ctx.conversations.define(step, handler, { persist: true })` grava cada espera do passo no storage do bot (coleção `waits` do namespace `$conversations`), e o boot seguinte a restaura depois do `setup` de todos os plugins. A mensagem segue lendo a espera da memória; o storage é a cópia. O vencimento gravado é absoluto: a espera que venceu durante o restart expira no boot (e roda o `onExpire` do passo, se houver), e a de passo que não existe mais é descartada com `warn`. Um reload do plugin mantém as esperas persistidas; `disable`, `setup` que falha ou passo renomeado as removem. Sem `persist`, nada muda.

No kit, `TestBot.restart(overrides?)` para o bot e sobe outro sobre o mesmo storage, para testar o que sobrevive a um deploy. O storage em memória agora é criado pelo kit e fechado no `stop()` do último bot.
