---
"@usebridger/core": minor
---

Correlação (`trace`) e trilha de eventos por mensagem, request e job (ADR 0120, #232).

- **`trace`:** cada mensagem (clique, comando nativo, expiração de passo), request HTTP, execução de job e o boot dos plugins ganha um id de 32 hex (W3C Trace Context), guardado num `AsyncLocalStorage`. Ele entra sozinho em toda linha do `createLogger`, inclusive o `ctx.log` dos plugins, e nos `fields` do sinal `log`. O envio sai no trace de quem o enfileirou; um job guarda o trace de quem o agendou como `cause` e roda num trace próprio.
- **HTTP:** o `traceparent` válido do request é adotado como `trace`, e a resposta das rotas de plugin e transport devolve o header.
- **Trilha:** eventos `message.received`, `message.handled`, `outbound.sent`, `step.entered`, `step.expired`, `job.run` e `http.request`, em `info`, só com fatos e metadados (nunca o texto da mensagem). `createBot({ trail: 'info' | 'debug' | 'off' })` rebaixa ou desliga a trilha sem mexer nos erros. Exportado o tipo `TrailMode`.
- Todo logger do `createLogger` carimba o `trace` corrente na linha. Um logger próprio que não vem dele só o leva se o ler do contexto; o sinal `log` o leva sempre.
