---
'@usebridger/core': minor
---

Envio de template e janela de atendimento (ADR 0124): `OutgoingContent` ganha `template` atrás da
capability `send.template`, o transport pode expor `window(chatId)`, e `ctx.send.window(chatId)`
devolve o estado da janela (`null` onde a plataforma não tem). Novos exports:
`ConversationWindowError` (a fila não o re-tenta), `ConversationWindow` e `TemplateParam`.
