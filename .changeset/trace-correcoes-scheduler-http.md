---
"@usebridger/core": patch
---

Correções do `trace` (#246): o timer e o loop do scheduler rodam fora do trace de quem agendou, então `scheduler.storage.failed` não sai mais com o trace de uma mensagem alheia; o `traceparent` de resposta tenta o `set` direto antes de copiar a resposta e devolve a original se a cópia falhar (`Response.error()`); as flags do `traceparent` de entrada voltam na resposta (sem entrada, `01`).
