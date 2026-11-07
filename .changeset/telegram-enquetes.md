---
'@usebridger/transport-telegram': minor
---

O transport do Telegram passa a declarar `polls`: `reply.poll` envia uma enquete não anônima (`multiple` vira `allows_multiple_answers`) e o `poll_answer` chega como o evento `poll.vote`, com a escolha inteira em índices. Voto de enquete enviada antes do restart é descartado, com log `telegram.poll.vote-unknown`.
