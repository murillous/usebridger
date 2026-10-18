---
"@usebridger/core": minor
---

`ctx.observe` no contexto do plugin: observadores síncronos, por bot, dos sinais `message.handled` (rota, desfecho, espera na fila de entrada e duração do handler) e `outbound.sent` (desfecho, espera na fila de saída, re-tentativas e `replyTo`). A exceção de um observador vira `plugin.error` com `phase: 'observer'` (ADR 0106).
