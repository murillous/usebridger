---
'@usebridger/core': minor
'@usebridger/testing': patch
---

`ctx.scheduler.every(rule, job, payload?)` agenda jobs recorrentes, por intervalo (`{ everyMs }`, mínimo 60 s) ou por horário no fuso (`{ time: 'HH:mm', days?, timeZone }`, com horário de verão). `cancel(seriesId)` encerra a série, `next(id)` devolve a próxima ocorrência, e o handler recebe `scheduledAt` e `seriesId` no `JobContext`.
