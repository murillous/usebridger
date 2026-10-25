---
'@usebridger/core': minor
---

Retenção da auditoria (ADR 0122): opção `audit.retentionDays` no `createBot` (padrão 1825) e
expurgação (no máximo a cada 24 h) que apaga o prefixo vencido da cadeia, gravando `kernel.audit.purge` antes de apagar.
Novos eventos de log `audit.purged`, `audit.purge.skipped` e `audit.purge.failed`.
