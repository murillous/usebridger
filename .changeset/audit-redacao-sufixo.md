---
'@usebridger/core': minor
---

`ctx.audit` (ADR 0123): a redação dos `details` casa as chaves por sufixo, sem diferenciar
maiúscula, `_` nem `-`. `accessToken`, `refresh_token`, `clientSecret` e `dbPassword` passam a
sair como `[REDACTED]`; `tokenizer` continua em claro.
