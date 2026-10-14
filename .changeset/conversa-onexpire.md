---
'@usebridger/core': minor
---

`ctx.conversations.define(step, handler, { onExpire })`: o passo reage à espera que venceu sem resposta ("Encerrei por falta de resposta", lembrar de terminar um cadastro, registrar o abandono). O `onExpire` roda na fila do chat, com o prazo do comando, e recebe `chat`, `sender`, `step`, `data`, `reply` (no chat, sem citar), `log`, `t`, `signal` e `expectReply` para encadear outra espera. Só dispara quando o TTL vence: espera respondida, substituída, cancelada por comando ou descartada (teardown, reload, `stop()`) não dispara. A falha vira `plugin.error` com a fase nova `'step-expire'`; o `StepTimeoutError` ganha `stage` (`'run'` ou `'onExpire'`). Passo sem `onExpire` continua expirando em silêncio (ADR 0097).
