---
'@usebridger/core': minor
---

Auditoria automática das ações do kernel (ADR 0122): `kernel.plugin.enable|disable|reload`,
`kernel.config.update` (diff sem segredo), `kernel.secret.update` (só o caminho), `kernel.boot` e
`kernel.stop`, com o ator `system` ou o plugin admin. O dreno pedido (`flush`) agora cancela o timer
de 1 s do flush.
