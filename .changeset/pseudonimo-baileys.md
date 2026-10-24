---
"@usebridger/transport-baileys": patch
---

O log `baileys.lid.resolve-failed` deixa de levar o `lid` nos campos (ADR 0119, #231): nenhum LID, JID ou telefone cru sai nos logs do transport.
