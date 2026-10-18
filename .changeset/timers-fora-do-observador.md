---
"@usebridger/core": patch
---

A fila de saída roda cada envio no contexto assíncrono de quem o enfileirou, e o scheduler roda o loop no contexto de quem criou o serviço. Um `ctx.send` ou `ctx.schedule` feito num observador de `log` não silencia mais o sinal dos envios de outros chats nem dos jobs de outros plugins (#163).
